/* AOD 息屏灵动岛:空闲自动息屏、任意输入唤醒、配置持久化与天气缓存。
 * 配置写入在协议任务(低频);渲染任务并发读取配置/天气,经自旋锁保护。
 * 无 PCM、无任务创建、不持有传输或请求所有权。 */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "pet_p4_protocol.h"

#define PET_P4_AOD_ENGINE "p4-display-aod-v1"
#define PET_P4_AOD_ITEM_MAX 2
#define PET_P4_AOD_TIMEOUT_MAX_MIN 1440u
#define PET_P4_AOD_WEATHER_COND_MAX 32
#define PET_P4_AOD_BRIGHTNESS_PERCENT 15u

typedef enum {
  PET_P4_AOD_ITEM_NONE = 0,
  PET_P4_AOD_ITEM_TIME,
  PET_P4_AOD_ITEM_DATE,
  PET_P4_AOD_ITEM_WEATHER,
  PET_P4_AOD_ITEM_AGENT,
} pet_p4_aod_item_t;

typedef struct {
  bool valid;
  int hour, minute;
  int month, day;
  int weekday; /* 0=周一 .. 6=周日 */
} pet_p4_aod_time_t;

void pet_p4_display_aod_boot_load(void);
bool pet_p4_display_aod_active(void);
unsigned pet_p4_display_aod_timeout_min(void);
unsigned pet_p4_display_aod_item_count(void);
pet_p4_aod_item_t pet_p4_display_aod_item(unsigned index);
/* 输入汇聚点(input/touch 队列循环)调用:记录活跃时间;AOD 激活时吞掉该
 * 事件并唤醒,返回 true=事件已消费,调用方不得再做其他分发。 */
bool pet_p4_display_aod_consume_input(pet_p4_runtime_state_t *state);
/* 主循环(持 state 锁内、input_process 之后)调用:自动进入门控在此。 */
void pet_p4_display_aod_process(pet_p4_runtime_state_t *state, unsigned long long now_ms);
/* PC 显式息屏:绕过自动门控,仅 touch_test 除外。返回是否进入。 */
bool pet_p4_display_aod_request_enter(pet_p4_runtime_state_t *state, unsigned long long now_ms);
/* 校验并应用配置,尽力持久化。返回错误串(NULL=成功);persisted 报告落盘。 */
const char *pet_p4_display_aod_apply_config(
  unsigned timeout_min,
  const pet_p4_aod_item_t *items,
  unsigned count,
  bool *persisted
);
void pet_p4_display_aod_set_weather(double temp_c, const char *cond);
bool pet_p4_display_aod_weather(double *temp_c, const char **cond);
bool pet_p4_display_aod_local_time(unsigned long long now_ms, pet_p4_aod_time_t *out);
/* Consumes no JSON ownership; state must be the caller's locked runtime state.
 * Returns one cJSON-owned serialized result, or NULL on malformed request.
 * Caller sends/frees once, with original route. */
char *pet_p4_display_aod_reply(
  const cJSON *root,
  pet_p4_runtime_state_t *state,
  bool *ok
);
