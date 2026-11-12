/*
 * [Input] 全局语音识别服务商配置（voice_chat_settings）与各适配器实现。
 * [Output] `create()`：按当前配置构造一轮识别（Box<dyn SpeechRecognizer>）。每轮语音开始时
 *          调用一次，服务商切换下一轮即生效。
 * [Pos] ASR 多服务商工厂 in pc/src-tauri/src。
 * [Sync] 更新此 header。
 */

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::volcengine_asr::StreamingSpeechEvent;

/// 构造一轮识别。`callback` 与火山实现共享同一事件语义。
pub fn create(callback: impl Fn(StreamingSpeechEvent) + Send + Sync + 'static)
    -> Result<Box<dyn crate::speech::SpeechRecognizer>, String> {
    let config = crate::voice_chat_settings::asr_engine_config()?;
    match config.provider.as_str() {
        "volcengine" => Ok(Box::new(crate::volcengine_asr::StreamingSpeechRecognizer::start(callback)?)),
        "dashscope" => Ok(Box::new(crate::dashscope_asr::DashscopeAsr::start(
            crate::dashscope_asr::DashscopeAsrConfig {
                api_key: config.api_key, base_url: config.base_url, model: config.model,
            },
            callback,
        )?)),
        // shortcut: OpenAI 兼容转写是一次性接口，整轮只有 Final 没有部分结果；
        // 出现低延迟需求时为该类服务商补流式协议。
        "custom" => Ok(Box::new(OneShotAsr::start(
            crate::openai_audio::OpenAiAsrConfig {
                base_url: config.base_url, api_key: config.api_key, model: config.model,
                language: config.language,
            },
            callback,
        ))),
        "mimo" => Err("小米 MiMo 暂不支持语音识别，请选择豆包、通义千问或自定义服务商".into()),
        other => Err(format!("不支持的语音识别服务商：{other}")),
    }
}

/// OpenAI 兼容 /audio/transcriptions 的一次性识别轮次：缓冲整轮 PCM，finish 时统一上传，
/// 只发 Final 事件（无 Partial）。
pub struct OneShotAsr {
    inner: Arc<Mutex<OneShotBuffer>>,
    cancelled: Arc<AtomicBool>,
    generation: u64,
}

#[derive(Default)]
struct OneShotBuffer {
    pcm: Vec<u8>,
    finished: bool,
    overflow: bool,
}

impl OneShotAsr {
    pub fn start(config: crate::openai_audio::OpenAiAsrConfig, callback: impl Fn(StreamingSpeechEvent) + Send + Sync + 'static) -> Self {
        let inner = Arc::new(Mutex::new(OneShotBuffer::default()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_buffer = inner.clone();
        let worker_cancelled = cancelled.clone();
        tauri::async_runtime::spawn(async move {
            let pcm = loop {
                {
                    let mut buffer = worker_buffer.lock().unwrap_or_else(|e| e.into_inner());
                    if buffer.overflow {
                        callback(StreamingSpeechEvent::Error("语音轮次超过 60 秒上限".into()));
                        return;
                    }
                    if buffer.finished {
                        break std::mem::take(&mut buffer.pcm);
                    }
                }
                if worker_cancelled.load(Ordering::SeqCst) { return; }
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            };
            if worker_cancelled.load(Ordering::SeqCst) { return; }
            callback(StreamingSpeechEvent::Ready);
            let text = match crate::openai_audio::transcribe(&config, &pcm).await {
                Ok(text) => text,
                Err(error) => {
                    callback(StreamingSpeechEvent::Error(error));
                    return;
                },
            };
            callback(StreamingSpeechEvent::Final { revision: 1, text, confidence: None });
        });
        Self { inner, cancelled, generation: crate::speech::next_recognizer_generation() }
    }
}

impl crate::speech::SpeechRecognizer for OneShotAsr {
    fn push_pcm(&self, pcm: &[u8]) -> Result<(), String> {
        let mut buffer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if buffer.finished { return Err("语音轮次已结束".into()); }
        if buffer.pcm.len() + pcm.len() > crate::openai_audio::MAX_TRANSCRIBE_PCM_BYTES {
            // 超限立即置位：worker 会在下一次轮询时以 Error 收尾，不再上传。
            buffer.overflow = true;
            return Err("语音轮次超过 60 秒上限".into());
        }
        buffer.pcm.extend_from_slice(pcm);
        Ok(())
    }

    fn finish(&self) -> Result<(), String> {
        let mut buffer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if buffer.finished { return Err("语音轮次已结束".into()); }
        buffer.finished = true;
        Ok(())
    }

    fn cancel(&self) { self.cancelled.store(true, Ordering::SeqCst); }

    fn generation(&self) -> u64 { self.generation }
}
