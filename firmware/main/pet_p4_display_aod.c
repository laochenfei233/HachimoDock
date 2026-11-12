#include "pet_p4_display_aod.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "nvs.h"
#include "pet_p4_audio.h"
#include "pet_p4_conversation.h"
#include "pet_p4_ota.h"

#define AOD_NAMESPACE "p4_display"
#define AOD_KEY "aod_v1"

static portMUX_TYPE aod_lock = portMUX_INITIALIZER_UNLOCKED;
static unsigned cfg_timeout_min = 5;
static pet_p4_aod_item_t cfg_items[PET_P4_AOD_ITEM_MAX] = {
  PET_P4_AOD_ITEM_TIME, PET_P4_AOD_ITEM_DATE};
static unsigned cfg_item_count = 2;
static bool aod_active;
static char prev_page[PET_P4_PAGE_MAX];
static unsigned long long last_input_ms;
static double weather_temp_c;
static char weather_cond[PET_P4_AOD_WEATHER_COND_MAX];
static bool weather_valid;
static bool boot_loaded;
static bool last_persist_ok;

static bool item_valid(pet_p4_aod_item_t item) {
  return item >= PET_P4_AOD_ITEM_NONE && item <= PET_P4_AOD_ITEM_AGENT;
}

static const char *item_name(pet_p4_aod_item_t item) {
  switch (item) {
    case PET_P4_AOD_ITEM_TIME: return "time";
    case PET_P4_AOD_ITEM_DATE: return "date";
    case PET_P4_AOD_ITEM_WEATHER: return "weather";
    case PET_P4_AOD_ITEM_AGENT: return "agent";
    case PET_P4_AOD_ITEM_NONE:
    default: return "none";
  }
}

void pet_p4_display_aod_boot_load(void) {
  if (boot_loaded) return;
  boot_loaded = true;
  nvs_handle_t handle;
  esp_err_t err = nvs_open(AOD_NAMESPACE, NVS_READONLY, &handle);
  uint32_t stored = 0;
  if (err == ESP_OK) {
    err = nvs_get_u32(handle, AOD_KEY, &stored);
    nvs_close(handle);
  }
  if (err != ESP_OK) return; /* Absent key keeps factory defaults. */
  unsigned timeout = (unsigned) (stored >> 16) & 0xffffu;
  pet_p4_aod_item_t items[PET_P4_AOD_ITEM_MAX] = {
    (pet_p4_aod_item_t) ((stored >> 8) & 0xffu),
    (pet_p4_aod_item_t) (stored & 0xffu)};
  unsigned count = 0;
  for (unsigned k = 0; k < PET_P4_AOD_ITEM_MAX; k++) {
    if (!item_valid(items[k])) return; /* Corrupt record: keep defaults. */
    if (items[k] != PET_P4_AOD_ITEM_NONE) count++;
  }
  if (timeout > PET_P4_AOD_TIMEOUT_MAX_MIN) return;
  portENTER_CRITICAL(&aod_lock);
  cfg_timeout_min = timeout;
  cfg_items[0] = items[0];
  cfg_items[1] = items[1];
  cfg_item_count = count;
  portEXIT_CRITICAL(&aod_lock);
}

bool pet_p4_display_aod_active(void) {
  return aod_active;
}

unsigned pet_p4_display_aod_timeout_min(void) {
  portENTER_CRITICAL(&aod_lock);
  unsigned value = cfg_timeout_min;
  portEXIT_CRITICAL(&aod_lock);
  return value;
}

unsigned pet_p4_display_aod_item_count(void) {
  portENTER_CRITICAL(&aod_lock);
  unsigned value = cfg_item_count;
  portEXIT_CRITICAL(&aod_lock);
  return value;
}

pet_p4_aod_item_t pet_p4_display_aod_item(unsigned index) {
  if (index >= PET_P4_AOD_ITEM_MAX) return PET_P4_AOD_ITEM_NONE;
  portENTER_CRITICAL(&aod_lock);
  pet_p4_aod_item_t value = cfg_items[index];
  portEXIT_CRITICAL(&aod_lock);
  return value;
}

static void enter_aod(pet_p4_runtime_state_t *state) {
  if (strcmp(state->screen_page, "aod") != 0) {
    snprintf(prev_page, sizeof(prev_page), "%s", state->screen_page);
  }
  snprintf(state->screen_page, sizeof(state->screen_page), "aod");
  pet_p4_lcd_set_brightness(PET_P4_AOD_BRIGHTNESS_PERCENT);
  aod_active = true;
}

static void exit_aod(pet_p4_runtime_state_t *state) {
  aod_active = false;
  snprintf(state->screen_page, sizeof(state->screen_page),
    "%s", prev_page[0] ? prev_page : "main");
  prev_page[0] = '\0';
  pet_p4_lcd_set_brightness(100);
}

bool pet_p4_display_aod_consume_input(pet_p4_runtime_state_t *state) {
  last_input_ms = (unsigned long long) (esp_timer_get_time() / 1000ULL);
  if (!aod_active) return false;
  /* Any physical input only wakes the screen; never leaks into bindings. */
  if (state) exit_aod(state);
  return true;
}

void pet_p4_display_aod_process(pet_p4_runtime_state_t *state, unsigned long long now_ms) {
  if (!state) return;
  if (aod_active) {
    /* The page may have been switched underneath (PC screen-page command);
     * never let the dim state outlive the AOD page. */
    if (strcmp(state->screen_page, "aod") != 0) exit_aod(state);
    return;
  }
  if (!cfg_timeout_min) return;
  if (!state->screen_page[0]
      || !strcmp(state->screen_page, "aod")
      || !strcmp(state->screen_page, "touch_test")) return;
  if (pet_p4_conversation_active(state)) return;
  if (state->asset_transfer_active || pet_p4_ota_transfer_active()) return;
  if (pet_p4_audio_playback_active() || pet_p4_audio_music_active()) return;
  if (pet_p4_state_approval_pending(state, now_ms)) return;
  if (now_ms < last_input_ms
      || now_ms - last_input_ms < (unsigned long long) cfg_timeout_min * 60000ULL) return;
  enter_aod(state);
}

bool pet_p4_display_aod_request_enter(
  pet_p4_runtime_state_t *state,
  unsigned long long now_ms
) {
  (void) now_ms;
  if (!state || aod_active || !strcmp(state->screen_page, "touch_test")) return false;
  enter_aod(state);
  return true;
}

const char *pet_p4_display_aod_apply_config(
  unsigned timeout_min,
  const pet_p4_aod_item_t *items,
  unsigned count,
  bool *persisted
) {
  if (persisted) *persisted = false;
  if (timeout_min > PET_P4_AOD_TIMEOUT_MAX_MIN) return "invalid_timeout";
  if (count > PET_P4_AOD_ITEM_MAX || !items) return "invalid_items";
  unsigned kept = 0;
  for (unsigned k = 0; k < count; k++) {
    if (!item_valid(items[k])) return "invalid_item_value";
    if (items[k] == PET_P4_AOD_ITEM_NONE) continue;
    for (unsigned prior = 0; prior < k; prior++) {
      if (items[prior] != PET_P4_AOD_ITEM_NONE && items[prior] == items[k])
        return "duplicate_item";
    }
    kept++;
  }
  portENTER_CRITICAL(&aod_lock);
  cfg_timeout_min = timeout_min;
  cfg_items[0] = count > 0 ? items[0] : PET_P4_AOD_ITEM_NONE;
  cfg_items[1] = count > 1 ? items[1] : PET_P4_AOD_ITEM_NONE;
  cfg_item_count = kept;
  portEXIT_CRITICAL(&aod_lock);
  uint32_t encoded = ((uint32_t) timeout_min << 16)
    | ((uint32_t) cfg_items[0] << 8) | (uint32_t) cfg_items[1];
  nvs_handle_t handle;
  esp_err_t err = nvs_open(AOD_NAMESPACE, NVS_READWRITE, &handle);
  if (err == ESP_OK) {
    err = nvs_set_u32(handle, AOD_KEY, encoded);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
  }
  last_persist_ok = err == ESP_OK;
  if (persisted) *persisted = last_persist_ok;
  return NULL;
}

void pet_p4_display_aod_set_weather(double temp_c, const char *cond) {
  if (!cond || !cond[0]) return;
  portENTER_CRITICAL(&aod_lock);
  weather_temp_c = isfinite(temp_c) ? temp_c : 0.0;
  snprintf(weather_cond, sizeof(weather_cond), "%s", cond);
  weather_valid = true;
  portEXIT_CRITICAL(&aod_lock);
}

bool pet_p4_display_aod_weather(double *temp_c, const char **cond) {
  static char snapshot[PET_P4_AOD_WEATHER_COND_MAX];
  portENTER_CRITICAL(&aod_lock);
  bool valid = weather_valid;
  if (valid) {
    snprintf(snapshot, sizeof(snapshot), "%s", weather_cond);
    if (temp_c) *temp_c = weather_temp_c;
  }
  portEXIT_CRITICAL(&aod_lock);
  if (!valid) return false;
  if (cond) *cond = snapshot;
  return true;
}

/* Howard Hinnant 的 civil-from-days:本地纪元日 -> 年/月/日。 */
static void civil_from_days(long long days, int *year, int *month, int *day) {
  days += 719468;
  long long era = (days >= 0 ? days : days - 146096) / 146097;
  unsigned doe = (unsigned) (days - era * 146097);
  unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = (long long) yoe + era * 400;
  unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned mp = (5 * doy + 2) / 153;
  *day = (int) (doy - (153 * mp + 2) / 5 + 1);
  *month = (int) (mp < 10 ? mp + 3 : mp - 9);
  *year = (int) (y + (*month <= 2));
}

bool pet_p4_display_aod_local_time(unsigned long long now_ms, pet_p4_aod_time_t *out) {
  if (!out) return false;
  out->valid = false;
  long long wall_seconds;
  if (!pet_p4_miniapp_wall_seconds(now_ms, &wall_seconds)) return false;
  long long days = wall_seconds / 86400;
  long long remainder = wall_seconds % 86400;
  if (remainder < 0) {
    remainder += 86400;
    days -= 1;
  }
  int year;
  civil_from_days(days, &year, &out->month, &out->day);
  (void) year;
  out->hour = (int) (remainder / 3600);
  out->minute = (int) ((remainder % 3600) / 60);
  out->weekday = (int) ((days + 3) % 7); /* 1970-01-01 是周四;0=周一。 */
  if (out->weekday < 0) out->weekday += 7;
  out->valid = true;
  return true;
}

static pet_p4_aod_item_t item_from_name(const char *name) {
  if (!name) return (pet_p4_aod_item_t) -1;
  if (!strcmp(name, "none")) return PET_P4_AOD_ITEM_NONE;
  if (!strcmp(name, "time")) return PET_P4_AOD_ITEM_TIME;
  if (!strcmp(name, "date")) return PET_P4_AOD_ITEM_DATE;
  if (!strcmp(name, "weather")) return PET_P4_AOD_ITEM_WEATHER;
  if (!strcmp(name, "agent")) return PET_P4_AOD_ITEM_AGENT;
  return (pet_p4_aod_item_t) -1;
}

/* 镜像 audio/volume 的请求约束:精确 board 绑定、显式 requestId、字段封闭。 */
char *pet_p4_display_aod_reply(
  const cJSON *root,
  pet_p4_runtime_state_t *state,
  bool *ok
) {
  *ok = false;
  if (!state) return NULL;
  const cJSON *payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
  const cJSON *topic = cJSON_GetObjectItemCaseSensitive(root, "topic");
  if (!cJSON_IsObject(root) || !cJSON_IsObject(payload)
      || !cJSON_IsString(topic) || strcmp(topic->valuestring, "display/aod"))
    return NULL;
  const cJSON *operation = cJSON_GetObjectItemCaseSensitive(payload, "operation");
  const cJSON *request_id = cJSON_GetObjectItemCaseSensitive(payload, "requestId");
  const cJSON *expected = cJSON_GetObjectItemCaseSensitive(payload, "expectedBoardDeviceId");
  bool is_set = cJSON_IsString(operation) && !strcmp(operation->valuestring, "set");
  bool is_enter = cJSON_IsString(operation) && !strcmp(operation->valuestring, "enter");
  bool is_query = cJSON_IsString(operation) && !strcmp(operation->valuestring, "query");
  if ((!is_set && !is_enter && !is_query)
      || !cJSON_IsString(request_id) || !request_id->valuestring[0]
      || !cJSON_IsString(expected)
      || strcmp(expected->valuestring, state->board_device_id))
    return NULL;
  unsigned timeout = 0;
  pet_p4_aod_item_t items[PET_P4_AOD_ITEM_MAX] = {
    PET_P4_AOD_ITEM_NONE, PET_P4_AOD_ITEM_NONE};
  unsigned count = 0;
  if (is_set) {
    const cJSON *jtimeout = cJSON_GetObjectItemCaseSensitive(payload, "timeoutMinutes");
    if (!cJSON_IsNumber(jtimeout) || !isfinite(jtimeout->valuedouble)
        || jtimeout->valuedouble < 0
        || jtimeout->valuedouble > (double) PET_P4_AOD_TIMEOUT_MAX_MIN
        || jtimeout->valuedouble != (double) (unsigned) jtimeout->valuedouble)
      return NULL;
    timeout = (unsigned) jtimeout->valuedouble;
    const cJSON *list = cJSON_GetObjectItemCaseSensitive(payload, "items");
    if (!cJSON_IsArray(list)) return NULL;
    int size = cJSON_GetArraySize(list);
    if (size < 0 || (unsigned) size > PET_P4_AOD_ITEM_MAX) return NULL;
    const cJSON *field;
    unsigned index = 0;
    cJSON_ArrayForEach(field, list) {
      if (!cJSON_IsString(field)) return NULL;
      pet_p4_aod_item_t item = item_from_name(field->valuestring);
      if (!item_valid(item)) return NULL;
      items[index++] = item;
    }
    count = (unsigned) size;
  }
  bool applied = false;
  bool persisted = is_query ? last_persist_ok : false;
  const char *error = NULL;
  if (is_query) {
    applied = true;
  } else if (is_enter) {
    /* 已在息屏时视为成功;touch_test 诊断页除外。 */
    applied = pet_p4_display_aod_active()
      || pet_p4_display_aod_request_enter(state,
        (unsigned long long) (esp_timer_get_time() / 1000ULL));
    if (!applied) error = "aod_unavailable";
  } else {
    error = pet_p4_display_aod_apply_config(timeout, items, count, &persisted);
    applied = error == NULL;
  }
  cJSON *reply = cJSON_CreateObject();
  cJSON *reply_payload = cJSON_CreateObject();
  char *line = NULL;
  if (reply && reply_payload
      && cJSON_AddItemToObject(reply, "payload", reply_payload)
      && cJSON_AddStringToObject(reply, "topic", "display/aod-state")
      && cJSON_AddStringToObject(reply_payload, "engine", PET_P4_AOD_ENGINE)
      && cJSON_AddStringToObject(reply_payload, "boardDeviceId", state->board_device_id)
      && cJSON_AddStringToObject(reply_payload, "requestId", request_id->valuestring)
      && cJSON_AddBoolToObject(reply_payload, "ok", applied)
      && cJSON_AddNumberToObject(reply_payload, "timeoutMinutes",
        (double) pet_p4_display_aod_timeout_min())
      && cJSON_AddBoolToObject(reply_payload, "persisted", persisted)
      && cJSON_AddBoolToObject(reply_payload, "active",
        pet_p4_display_aod_active())) {
    cJSON *jitems = cJSON_AddArrayToObject(reply_payload, "items");
    bool listed = jitems != NULL;
    for (unsigned k = 0; listed && k < PET_P4_AOD_ITEM_MAX; k++) {
      listed = cJSON_AddItemToArray(jitems,
        cJSON_CreateString(item_name(pet_p4_display_aod_item(k))));
    }
    if (listed && error && !cJSON_AddStringToObject(reply_payload, "error", error))
      listed = false;
    if (listed) line = cJSON_PrintUnformatted(reply);
  }
  cJSON_Delete(reply);
  *ok = applied;
  return line;
}
