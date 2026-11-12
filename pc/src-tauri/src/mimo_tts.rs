/*
 * [Input] 小米 MiMo 开放平台语音合成的 API Key、模型（mimo-v2.5-tts 系列）与音色 ID。
 * [Output] MiMo 语音合成走 OpenAI Chat Completions 兼容端点（POST /v1/chat/completions，
 *          待合成文本放在 assistant 消息，audio.voice 指定音色），响应里
 *          choices[].message.audio.data 为 Base64 WAV；解码 WAV 头得到实际采样率，
 *          重采样为 16 kHz 单声道 S16LE PCM 后回调。语速参数不受支持，忽略。
 * [Pos] TTS 适配器 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub const DEFAULT_VOICE: &str = "mimo_default";

pub struct MimoTtsClient {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub voice: String,
}

impl MimoTtsClient {
    pub fn new(api_key: String, base_url: String, model: String, voice: String) -> Self {
        Self { api_key, base_url, model, voice }
    }

    pub fn interrupt(&mut self) {}
    pub async fn reset(&mut self) {}

    async fn synthesize_inner(&mut self, text: &str, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<usize, String> {
        let clean = text.trim();
        if clean.is_empty() { return Ok(0); }
        let url = format!("{}/chat/completions", self.base_url.trim().trim_end_matches('/'));
        let payload = serde_json::json!({
            "model": self.model.trim(),
            "messages": [{"role": "assistant", "content": clean}],
            "audio": {
                "format": "wav",
                "voice": if self.voice.trim().is_empty() { DEFAULT_VOICE } else { self.voice.trim() },
            },
        });
        let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
        let response = client.post(&url).bearer_auth(self.api_key.trim()).json(&payload).send().await
            .map_err(|e| crate::llm_network::connection_error(&e))?;
        let status = response.status();
        let raw = read_limited(response, 16 * 1024).await;
        if !status.is_success() {
            return Err(format!("语音合成请求失败（HTTP {}）{raw}", status.as_u16()));
        }
        let value: serde_json::Value = serde_json::from_str(raw.trim()).map_err(|_| "语音合成响应格式不正确")?;
        if let Some(message) = value["error"]["message"].as_str() {
            return Err(format!("语音合成被服务商拒绝：{message}"));
        }
        let audio = value["choices"][0]["message"]["audio"]["data"].as_str()
            .ok_or_else(|| "语音合成响应缺少音频".to_string())?;
        let wav = base64::engine::general_purpose::STANDARD.decode(audio.trim())
            .map_err(|_| "语音合成音频解码失败")?;
        let mut emitted = 0usize;
        wav_bytes_to_pcm16k(&wav, &mut |pcm| {
            emitted += pcm.len();
            on_pcm(pcm);
        })?;
        if emitted == 0 {
            return Err("语音合成未返回任何音频".into());
        }
        Ok(emitted)
    }
}

impl crate::speech::TtsEngine for MimoTtsClient {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: crate::speech::PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        Box::pin(async move { MimoTtsClient::synthesize_inner(self, text, on_pcm).await })
    }
    fn interrupt(&mut self) { MimoTtsClient::interrupt(self); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { MimoTtsClient::reset(self).await })
    }
}

/// 解析 WAV（PCM16/IEEE-float32，任意声道与采样率）并重采样为 16 kHz 单声道 S16LE。
pub fn wav_bytes_to_pcm16k(wav: &[u8], on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<usize, String> {
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut is_float = false;
    let mut data: &[u8] = &[];
    let mut cursor = 12usize; // RIFF 头 + "WAVE"
    while cursor + 8 <= wav.len() {
        let id = &wav[cursor..cursor + 4];
        let size = u32::from_le_bytes(wav[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
        let payload_start = cursor + 8;
        let payload_end = payload_start.saturating_add(size).min(wav.len());
        let payload = &wav[payload_start..payload_end];
        match id {
            b"fmt " if payload.len() >= 16 => {
                let format = u16::from_le_bytes(payload[0..2].try_into().unwrap());
                is_float = format == 3;
                channels = u16::from_le_bytes(payload[2..4].try_into().unwrap());
                sample_rate = u32::from_le_bytes(payload[4..8].try_into().unwrap());
                bits = u16::from_le_bytes(payload[14..16].try_into().unwrap());
            },
            b"data" => data = payload,
            _ => {},
        }
        cursor = payload_start + size + (size & 1); // chunk 按 2 字节对齐
    }
    if channels == 0 || sample_rate == 0 || data.is_empty() {
        return Err("语音合成音频缺少有效的 WAV 头".into());
    }
    if (!is_float && bits != 16) || (is_float && bits != 32) || channels == 0 {
        return Err(format!("语音合成音频格式暂不支持（{bits} 位）"));
    }
    let step = f64::from(sample_rate) / 16_000.0;
    let bytes_per_sample = (bits / 8) as usize;
    let frame = bytes_per_sample * channels as usize;
    if frame == 0 { return Err("语音合成音频格式无效".into()); }
    let mut state = crate::openai_audio::ResampleState::with_step(step);
    let mut emitted = 0usize;
    // 逐样本重采样后攒批回调，避免每个样本一次 on_pcm 分片。
    let mut pending: Vec<u8> = Vec::with_capacity(8192);
    let mut flush = |pending: &mut Vec<u8>| {
        if !pending.is_empty() {
            emitted += pending.len();
            on_pcm(pending);
            pending.clear();
        }
    };
    for chunk in data.chunks_exact(frame) {
        let mut sum = 0.0f32;
        for channel in 0..channels as usize {
            let at = channel * bytes_per_sample;
            sum += if is_float {
                f32::from_le_bytes(chunk[at..at + 4].try_into().unwrap())
            } else {
                f32::from(i16::from_le_bytes(chunk[at..at + 2].try_into().unwrap()))
            };
        }
        let mono = sum / channels as f32;
        // IEEE-float WAV 样本在 [-1,1]；整型路径已是 i16 量纲，仅浮点需要缩放。
        let scaled = if is_float { mono * 32_767.0 } else { mono };
        let bytes = (scaled.clamp(-32768.0, 32767.0) as i16).to_le_bytes();
        crate::openai_audio::resample_mono_16k(&bytes, &mut state, &mut |pcm| pending.extend_from_slice(pcm));
        if pending.len() >= 8192 { flush(&mut pending); }
    }
    flush(&mut pending);
    if emitted == 0 {
        return Err("语音合成音频没有可解码的数据".into());
    }
    Ok(emitted)
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= limit { break; }
    }
    String::from_utf8_lossy(&bytes).trim().replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(channels: u16, sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + samples.len() * 2) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * channels as u32 * 2).to_le_bytes());
        wav.extend_from_slice(&(channels * 2).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&((samples.len() * 2) as u32).to_le_bytes());
        for sample in samples { wav.extend_from_slice(&sample.to_le_bytes()); }
        wav
    }

    #[test]
    fn wav_16k_mono_passes_through_and_error_paths_are_clear() {
        let mut out = Vec::new();
        let written = wav_bytes_to_pcm16k(&wav_bytes(1, 16_000, &[100, -100, 300]), &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        assert_eq!(written, 6); // 3 samples × 2 bytes
        assert_eq!(out, [100i16, -100, 300].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>());

        // 立体声取均值。
        let mut out = Vec::new();
        wav_bytes_to_pcm16k(&wav_bytes(2, 16_000, &[100, 200, 20, 40]), &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        assert_eq!(out.len(), 4);
        let left = i16::from_le_bytes([out[0], out[1]]);
        assert_eq!(left, 150);

        // 无 data 块 → 明确报错。
        assert!(wav_bytes_to_pcm16k(&wav_bytes(1, 16_000, &[]), &mut |_| {}).is_err());
    }

    #[test]
    fn response_shape_extraction_and_error_message() {
        let audio = base64::engine::general_purpose::STANDARD.encode(wav_bytes(1, 16_000, &[5]));
        let ok = serde_json::json!({"choices": [{"message": {"audio": {"data": audio}}}]});
        assert!(ok["choices"][0]["message"]["audio"]["data"].as_str().is_some());
        let err = serde_json::json!({"error": {"message": "bad voice"}});
        assert_eq!(err["error"]["message"].as_str(), Some("bad voice"));
    }

    fn wav_float_bytes(sample_rate: u32, samples: &[f32]) -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + samples.len() * 4) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&32u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&((samples.len() * 4) as u32).to_le_bytes());
        for sample in samples { wav.extend_from_slice(&sample.to_le_bytes()); }
        wav
    }

    #[test]
    fn float_wav_is_scaled_to_i16_amplitude_not_near_silence() {
        // IEEE-float WAV（[-1,1]）必须缩放到 i16 量纲；0.5 → 约 16383。
        let mut out = Vec::new();
        wav_bytes_to_pcm16k(&wav_float_bytes(16_000, &[0.5, -0.25]), &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 16_383);
        assert_eq!(i16::from_le_bytes([out[2], out[3]]), -8_191); // 截断取整
    }
}
