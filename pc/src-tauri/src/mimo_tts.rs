/*
 * [Input] 小米 MiMo 开放平台语音合成的 API Key、模型（mimo-v2.5-tts 系列）与音色 ID；
 *         以及短语音识别（mimo-v2.5-asr）的 API Key、模型与语言。
 * [Output] TTS 走 OpenAI Chat Completions 兼容端点（POST /v1/chat/completions，
 *          待合成文本放在 assistant 消息，audio.voice 指定音色），响应里
 *          choices[].message.audio.data 为 Base64 WAV；解码 WAV 头得到实际采样率，
 *          重采样为 16 kHz 单声道 S16LE PCM 后回调。语速参数不受支持，忽略。
 *          ASR 走同一端点的短语音识别：input_audio（Base64 WAV data URL，≤10MB），
 *          整轮一次性转写，返回 choices[].message.content 文本。
 * [Pos] MiMo 适配器（TTS + ASR） in pc/src-tauri/src。
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

// ---- ASR（Chat Completions 短语音识别） ----------------------------------------------------------

pub struct MimoAsrConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub language: Option<String>,
}

/// 组装 MiMo 短语音识别请求体：整轮 PCM 加 WAV 头后以 input_audio（Base64 data URL）上传。
/// 语言缺省 auto；仅支持 auto/zh/en。
pub fn chat_asr_payload(model: &str, wav_base64: &str, language: Option<&str>) -> serde_json::Value {
    let language = language.map(str::trim).filter(|l| !l.is_empty() && *l != "auto");
    let mut payload = serde_json::json!({
        "model": model.trim(),
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {"data": format!("data:audio/wav;base64,{wav_base64}")},
            }],
        }],
    });
    if let Some(language) = language {
        payload["asr_options"] = serde_json::json!({"language": language});
    }
    payload
}

/// 一次性识别：整轮 PCM（16 kHz 单声道 S16LE）→ WAV → Chat Completions → 文本。
pub async fn transcribe(cfg: &MimoAsrConfig, pcm_16k: &[u8]) -> Result<String, String> {
    if pcm_16k.is_empty() { return Ok(String::new()); }
    let pcm = if pcm_16k.len() > crate::openai_audio::MAX_TRANSCRIBE_PCM_BYTES {
        &pcm_16k[..crate::openai_audio::MAX_TRANSCRIBE_PCM_BYTES]
    } else {
        pcm_16k
    };
    let wav_base64 = base64::engine::general_purpose::STANDARD.encode(crate::openai_audio::wav_wrap(pcm));
    let payload = chat_asr_payload(&cfg.model, &wav_base64, cfg.language.as_deref());
    let url = format!("{}/chat/completions", cfg.base_url.trim().trim_end_matches('/'));
    let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
    let response = client.post(&url).bearer_auth(cfg.api_key.trim()).json(&payload).send().await
        .map_err(|e| crate::llm_network::connection_error(&e))?;
    let status = response.status();
    let raw = read_limited(response, 64 * 1024).await;
    if !status.is_success() {
        return Err(format!("语音识别请求失败（HTTP {}）{}", status.as_u16(), raw.replace('\n', " ")));
    }
    transcript_from_response(raw.trim())
}

/// 从 Chat Completions 响应提取转写文本（choices[].message.content），并识别 error 载荷。
fn transcript_from_response(raw: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "语音识别响应格式不正确")?;
    if let Some(message) = value["error"]["message"].as_str() {
        return Err(format!("语音识别被服务商拒绝：{message}"));
    }
    value["choices"][0]["message"]["content"].as_str().map(str::trim).map(str::to_owned)
        .ok_or_else(|| "语音识别响应缺少文本".to_string())
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

    #[test]
    fn chat_asr_payload_carries_wav_data_url_and_optional_language() {
        let auto = chat_asr_payload("mimo-v2.5-asr", "QUJD", None);
        assert_eq!(auto["model"], "mimo-v2.5-asr");
        assert_eq!(auto["messages"][0]["role"], "user");
        let audio = &auto["messages"][0]["content"][0]["input_audio"]["data"];
        assert_eq!(audio.as_str().map(|value| value.to_string()), Some("data:audio/wav;base64,QUJD".to_string()));
        assert!(auto.get("asr_options").is_none());
        let zh = chat_asr_payload("m", "QQ==", Some("zh"));
        assert_eq!(zh["asr_options"]["language"], "zh");
        assert_eq!(chat_asr_payload("m", "QQ==", Some(" auto ")).get("asr_options"), None);
    }

    #[test]
    fn asr_transcript_is_extracted_from_chat_message_content() {
        let ok = serde_json::json!({"choices": [{"message": {"role": "assistant", "content": " 今天天气不错 "}}]});
        assert_eq!(transcript_from_response(&ok.to_string()).unwrap(), "今天天气不错");
        let err = serde_json::json!({"error": {"message": "quota exceeded"}});
        assert!(transcript_from_response(&err.to_string()).unwrap_err().contains("quota exceeded"));
        let empty = serde_json::json!({"choices": []});
        assert!(transcript_from_response(&empty.to_string()).is_err());
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
