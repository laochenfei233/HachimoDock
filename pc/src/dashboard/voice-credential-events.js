import { API_CONFIGURATION_UPDATED_EVENT } from '../lib/api-configuration.js';

// 识别凭据广播：豆包沿用旧 providerId，其他服务商统一广播 voice-asr（configured === true 仍为必要条件）。
const ASR_CREDENTIAL_PROVIDER_IDS = new Set(['volcengine-asr', 'voice-asr']);

// Subscribe in the persistent dashboard controller, never in its visible-only
// voice panel. API settings deliberately unmounts that panel to save resources.
export function subscribeAsrCredentialUpdates(target, onSaved) {
  const handleSaved = event => {
    if (!ASR_CREDENTIAL_PROVIDER_IDS.has(event?.detail?.providerId) || event.detail.configured !== true) return;
    onSaved();
  };
  target.addEventListener(API_CONFIGURATION_UPDATED_EVENT, handleSaved);
  return () => target.removeEventListener(API_CONFIGURATION_UPDATED_EVENT, handleSaved);
}
