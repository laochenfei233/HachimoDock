/*
 * [Input] 通义千问（阿里云百炼）语音合成的 API Key、模型（cosyvoice-v3-flash 等预设）与音色。
 * [Output] DashScope 原生 HTTP 非实时语音合成（SSE 流式）：POST /api/v1/services/audio/tts/
 *          SpeechSynthesizer，X-DashScope-SSE: enable，逐事件解析 output.audio.data 的
 *          Base64 PCM（请求 16 kHz 单声道）并回调。shortcut: 非实时接口不支持语速参数，
 *          speed 被忽略；需要变速时改走实时 WS 合成接口。
 * [Pos] TTS 适配器 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub struct DashscopeTtsClient {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub voice: String,
}

impl DashscopeTtsClient {
    pub fn new(api_key: String, base_url: String, model: String, voice: String) -> Self {
        Self { api_key, base_url, model, voice }
    }

    pub fn interrupt(&mut self) {}
    pub async fn reset(&mut self) {}

    async fn synthesize_inner(&mut self, text: &str, on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<usize, String> {
        let clean = text.trim();
        if clean.is_empty() { return Ok(0); }
        let url = format!("{}/api/v1/services/audio/tts/SpeechSynthesizer", self.base_url.trim().trim_end_matches('/'));
        let payload = serde_json::json!({
            "model": self.model.trim(),
            "input": {
                "text": clean,
                "voice": self.voice.trim(),
                "format": "pcm",
                "sample_rate": 16_000,
            },
        });
        let client = crate::llm_network::client(REQUEST_TIMEOUT)?;
        let mut response = client.post(&url)
            .bearer_auth(self.api_key.trim())
            .header("X-DashScope-SSE", "enable")
            .json(&payload)
            .send().await.map_err(|e| crate::llm_network::connection_error(&e))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let detail = read_limited(&mut response, 512).await;
            return Err(format!("语音合成请求失败（HTTP {status}）{detail}"));
        }
        // SSE 流：逐个 data: 事件携带 Base64 PCM 分片；以连接 EOF 为结束信号。
        let mut emitted = 0usize;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => return Err("语音合成响应中断".into()),
            };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let mut sink = |pcm: &[u8]| {
                    emitted += pcm.len();
                    on_pcm(pcm);
                };
                parse_sse_line(&line[..line.len() - 1], &mut sink)?;
            }
        }
        if !buf.is_empty() {
            let mut sink = |pcm: &[u8]| {
                emitted += pcm.len();
                on_pcm(pcm);
            };
            parse_sse_line(&buf, &mut sink)?;
        }
        if emitted == 0 {
            return Err("语音合成未返回任何音频".into());
        }
        Ok(emitted)
    }
}

impl crate::speech::TtsEngine for DashscopeTtsClient {
    fn synthesize<'a>(&'a mut self, text: &'a str, on_pcm: crate::speech::PcmSink<'a>)
        -> Pin<Box<dyn Future<Output = Result<usize, String>> + Send + 'a>> {
        Box::pin(async move { DashscopeTtsClient::synthesize_inner(self, text, on_pcm).await })
    }
    fn interrupt(&mut self) { DashscopeTtsClient::interrupt(self); }
    fn reset<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move { DashscopeTtsClient::reset(self).await })
    }
}

/// 解析一行 SSE：`data:{json}`；音频分片在 output.audio.data（Base64）。
/// 错误事件形如 {"code":..,"message":..}——即使 HTTP 200 也要识别。
fn parse_sse_line(line: &[u8], on_pcm: &mut (dyn FnMut(&[u8]) + Send)) -> Result<(), String> {
    let line = String::from_utf8_lossy(line);
    let line = line.trim();
    let Some(payload) = line.strip_prefix("data:") else { return Ok(()); };
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" { return Ok(()); }
    let value: serde_json::Value = serde_json::from_str(payload)
        .map_err(|_| "语音合成响应格式不正确（SSE 事件非 JSON）")?;
    if let Some(message) = value["message"].as_str().filter(|_| value["code"].is_string() || value["status"].as_str() == Some("FAILED")) {
        return Err(format!("语音合成被服务商拒绝：{message}"));
    }
    if let Some(data) = value["output"]["audio"]["data"].as_str() {
        let pcm = base64::engine::general_purpose::STANDARD.decode(data.trim())
            .map_err(|_| "语音合成音频分片解码失败")?;
        if !pcm.is_empty() { on_pcm(&pcm); }
    }
    Ok(())
}

async fn read_limited(response: &mut reqwest::Response, limit: usize) -> String {
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

    #[test]
    fn sse_parser_extracts_base64_audio_and_rejects_error_payloads() {
        let mut out = Vec::new();
        parse_sse_line(b"", &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        parse_sse_line(b": keep-alive", &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        parse_sse_line(b"data: [DONE]", &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode([1, 2, 3]);
        let line = format!("data: {}", serde_json::json!({"output": {"audio": {"data": encoded}}}));
        parse_sse_line(line.as_bytes(), &mut |pcm| out.extend_from_slice(pcm)).unwrap();
        assert_eq!(out, [1, 2, 3]);
        let error = format!("data: {}", serde_json::json!({"code": "InvalidParameter", "message": "bad voice"}));
        assert!(parse_sse_line(error.as_bytes(), &mut |_| {}).unwrap_err().contains("bad voice"));
    }
}
