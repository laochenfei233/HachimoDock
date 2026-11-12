"""AOD 息屏灵动岛:host 契约。

配置校验/持久化编码与本地墙钟换算在宿主机真实编译执行;topic 接线、能力上报、
渲染分支与输入唤醒漏斗做静态契约断言。宿主机无 `cc` 时行为用例跳过(CI 必跑)。
"""
from calendar import timegm
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import subprocess

import pytest

from p4_render_trace_test import function

ROOT = Path(__file__).resolve().parents[1]
CC = shutil.which("cc")


def source(relative):
    return (ROOT / relative).read_text()


def test_protocol_wiring_is_present():
    protocol = source("main/pet_p4_protocol.c")
    assert 'strcmp(topic, "display/aod")' in protocol
    assert "pet_p4_display_aod_reply" in protocol
    # 旧固件语义:未知 display/ 前缀按已知未支持分类,而非 unknown_topic。
    assert 'strncmp(topic, "display/", 8) == 0' in protocol
    assert '"displayAod"' in protocol and "PET_P4_AOD_ENGINE" in protocol
    # 心跳天气搭载:数字温度 + 长度受限中文文案,写入设备侧缓存。
    assert '"aod"' in protocol and "pet_p4_display_aod_set_weather" in protocol
    assert "PET_P4_AOD_WEATHER_COND_MAX" in protocol


def test_input_touch_and_main_loop_funnels():
    input_source = source("main/pet_p4_input.c")
    touch_source = source("main/pet_p4_touch.c")
    main_source = source("main/pet_p4_main.c")
    assert "pet_p4_display_aod_consume_input(state)" in input_source
    assert "pet_p4_display_aod_consume_input(state)" in touch_source
    # 息屏激活时输入在审批处理之前即被吞掉:唤醒优先,事件不进入绑定分发。
    assert (
        input_source.index("pet_p4_display_aod_consume_input")
        < input_source.index("handle_approval_input(state, send_line, ctx, &event)")
    )
    # 主循环在 input_process 之后推进状态机(同一 state 锁内)。
    assert (
        main_source.index("pet_p4_input_process(&g_state, transport_send_line, NULL);")
        < main_source.index("pet_p4_display_aod_process(&g_state, now_ms);")
    )
    assert "pet_p4_display_aod_boot_load" in main_source


def test_renderer_branch_and_empty_config_black_screen():
    renderer = source("main/pet_p4_renderer.c")
    assert 'strcmp(page, "aod") == 0' in renderer
    assert "render_aod_page(view, now_ms)" in renderer
    # 两项皆 none:不画胶囊,仅纯黑息屏。
    assert "if (!slot_count) return;" in renderer
    assert "pet_p4_display_aod_local_time" in renderer
    assert "pet_p4_display_aod_weather" in renderer
    assert "pet_p4_view_status_label" in renderer


def test_lcd_brightness_wrapper_and_build_registration():
    lcd = source("main/pet_p4_lcd.c")
    assert "esp_err_t pet_p4_lcd_set_brightness(unsigned percent)" in lcd
    # 开机 reveal 把背光脚改成普通 GPIO,必须经 ledc_channel_config 重挂载。
    assert "ledc_channel_config" in lcd
    assert "CONFIG_BSP_DISPLAY_BRIGHTNESS_LEDC_CH" in lcd
    assert '"pet_p4_display_aod.c"' in source("main/CMakeLists.txt")


def test_auto_enter_gates_and_factory_defaults():
    aod = source("main/pet_p4_display_aod.c")
    # 自动进入门控:对话、资产/OTA 传输、音频播放/音乐、DSH 审批一律不进入。
    for gate in (
        "pet_p4_conversation_active(state)",
        "state->asset_transfer_active || pet_p4_ota_transfer_active()",
        "pet_p4_audio_playback_active() || pet_p4_audio_music_active()",
        "pet_p4_state_approval_pending(state, now_ms)",
    ):
        assert gate in aod
    # touch_test 诊断页与 timeout=0(禁用)之外才允许自动进入。
    assert '!strcmp(state->screen_page, "touch_test")' in aod
    assert "if (!cfg_timeout_min) return;" in aod
    # 唤醒恢复 prev_page,空则回 main;默认 5 分钟 + 时间/日期。
    assert 'prev_page[0] ? prev_page : "main"' in aod
    assert "cfg_timeout_min = 5" in aod
    assert "PET_P4_AOD_ITEM_TIME, PET_P4_AOD_ITEM_DATE" in aod


APPLY_HARNESS = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef int esp_err_t;
#define ESP_OK 0
#define AOD_NAMESPACE "p4_display"
#define AOD_KEY "aod_v1"
typedef unsigned nvs_handle_t;
#define NVS_READWRITE 2
static int nvs_fail;
static unsigned long nvs_stored;
static esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle) {
  (void)name;(void)mode;*handle = 1;return ESP_OK;
}
static esp_err_t nvs_set_u32(nvs_handle_t handle, const char *key, unsigned long value) {
  (void)handle;(void)key;if (nvs_fail) return -1;nvs_stored = value;return ESP_OK;
}
static esp_err_t nvs_commit(nvs_handle_t handle) {(void)handle;return nvs_fail ? -1 : ESP_OK;}
static void nvs_close(nvs_handle_t handle) {(void)handle;}
typedef int portMUX_TYPE;
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
#define PET_P4_AOD_ITEM_MAX 2
#define PET_P4_AOD_TIMEOUT_MAX_MIN 1440u
typedef enum {
  PET_P4_AOD_ITEM_NONE = 0,
  PET_P4_AOD_ITEM_TIME,
  PET_P4_AOD_ITEM_DATE,
  PET_P4_AOD_ITEM_WEATHER,
  PET_P4_AOD_ITEM_AGENT,
} pet_p4_aod_item_t;
static portMUX_TYPE aod_lock;
static unsigned cfg_timeout_min = 5;
static pet_p4_aod_item_t cfg_items[PET_P4_AOD_ITEM_MAX] = {
  PET_P4_AOD_ITEM_TIME, PET_P4_AOD_ITEM_DATE};
static unsigned cfg_item_count = 2;
static bool last_persist_ok;
"""


def run_host_test(tmp_path, name, code):
    if not CC:
        pytest.skip("host C compiler unavailable")
    source_file = tmp_path / f"{name}.c"
    source_file.write_text(code, encoding="utf-8")
    exe = tmp_path / name
    subprocess.run(
        [CC, "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
         "-o", str(exe), str(source_file)],
        check=True, timeout=60,
    )
    subprocess.run([str(exe)], check=True, timeout=60)


def test_apply_config_validates_encodes_and_reports_persistence(tmp_path):
    text = source("main/pet_p4_display_aod.c")
    code = (
        APPLY_HARNESS
        + function(text, "item_valid")
        + function(text, "pet_p4_display_aod_apply_config")
        + rf"""
int main(void) {{
  bool persisted = true;
  pet_p4_aod_item_t items[3];
  items[0] = items[1] = items[2] = PET_P4_AOD_ITEM_TIME;
  assert(!strcmp(pet_p4_display_aod_apply_config(1441, items, 1, &persisted), "invalid_timeout"));
  assert(!strcmp(pet_p4_display_aod_apply_config(5, items, 3, &persisted), "invalid_items"));
  items[0] = (pet_p4_aod_item_t) 99;
  assert(!strcmp(pet_p4_display_aod_apply_config(5, items, 1, &persisted), "invalid_item_value"));
  items[0] = items[1] = PET_P4_AOD_ITEM_TIME;
  assert(!strcmp(pet_p4_display_aod_apply_config(5, items, 2, &persisted), "duplicate_item"));
  items[0] = PET_P4_AOD_ITEM_WEATHER;items[1] = PET_P4_AOD_ITEM_AGENT;
  assert(pet_p4_display_aod_apply_config(7, items, 2, &persisted) == NULL);
  assert(persisted);
  assert(nvs_stored == ((7ul << 16)
    | ((unsigned long) PET_P4_AOD_ITEM_WEATHER << 8)
    | (unsigned long) PET_P4_AOD_ITEM_AGENT));
  assert(cfg_timeout_min == 7 && cfg_item_count == 2);
  /* 单项配置:第二槽归 none,编码仍占两槽。 */
  items[0] = PET_P4_AOD_ITEM_DATE;items[1] = PET_P4_AOD_ITEM_NONE;
  assert(pet_p4_display_aod_apply_config(0, items, 1, &persisted) == NULL);
  assert(nvs_stored == ((0ul << 16) | ((unsigned long) PET_P4_AOD_ITEM_DATE << 8)));
  assert(cfg_timeout_min == 0 && cfg_item_count == 1 && cfg_items[1] == PET_P4_AOD_ITEM_NONE);
  /* NVS 失败:内存配置仍生效,但 persisted 如实报告 false。 */
  nvs_fail = 1;
  items[0] = PET_P4_AOD_ITEM_TIME;items[1] = PET_P4_AOD_ITEM_NONE;
  assert(pet_p4_display_aod_apply_config(5, items, 1, &persisted) == NULL);
  assert(!persisted && cfg_timeout_min == 5);
  return 0;
}}
"""
    )
    run_host_test(tmp_path, "aod_apply", code)


def test_local_time_converts_host_wall_seconds(tmp_path):
    text = source("main/pet_p4_display_aod.c")
    # 与设备一致:miniapp g_wall_seconds = unixSeconds + utcOffsetMinutes*60,
    # 即"本地墙上钟当作纪元秒"的值(calendar.timegm),不是时刻的 UTC 时间戳。
    local = datetime(2026, 11, 12, 18, 30, tzinfo=timezone(timedelta(hours=8)))
    seconds = timegm(local.timetuple())  # naive 墙上钟元组,而非 UTC 时刻
    assert seconds == int(local.timestamp()) + 8 * 3600
    weekday = local.date().weekday()  # 周一=0,与固件约定一致
    code = (
        r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
typedef struct {
  bool valid;
  int hour, minute;
  int month, day;
  int weekday;
} pet_p4_aod_time_t;
static long long stub_wall;
static bool stub_ok;
bool pet_p4_miniapp_wall_seconds(unsigned long long now_ms, long long *out_seconds) {
  (void)now_ms;
  if (!stub_ok) return false;
  *out_seconds = stub_wall;
  return true;
}
"""
        + function(text, "civil_from_days")
        + function(text, "pet_p4_display_aod_local_time")
        + rf"""
int main(void) {{
  pet_p4_aod_time_t t;
  stub_ok = false;
  assert(!pet_p4_display_aod_local_time(0, &t) && !t.valid);
  stub_ok = true;
  stub_wall = {seconds}LL;
  assert(pet_p4_display_aod_local_time(5000, &t));
  assert(t.valid && t.hour == 18 && t.minute == 30);
  assert(t.month == 11 && t.day == 12 && t.weekday == {weekday});
  /* 纪元起点附近:1970-01-01 00:00:08 是周四。 */
  stub_wall = 8;
  assert(pet_p4_display_aod_local_time(0, &t));
  assert(t.day == 1 && t.month == 1 && t.weekday == 3 && t.hour == 0 && t.minute == 0);
  return 0;
}}
"""
    )
    run_host_test(tmp_path, "aod_local_time", code)
