//! 息屏灵动岛天气搭载:复用 hachimi-weather 组件的 PC 服务声明(v2,缺失时
//! 退回兼容 profile)与 app_weather 的缓存/后台刷新,在 USB 心跳上按需携带
//! {"tempC","cond"}。无独立数据 topic、无额外网络路径;心跳路径只做加锁快照。

use crate::app_weather::{self, Cache, GeoCache};
use crate::location_profile::Profile;
use std::sync::{Mutex, OnceLock};

const WEATHER_COMPONENT: &str = "hachimi-weather";
const KICK_INTERVAL_SEC: i64 = 1800; // 到期踢一次后台定位/刷新;节流仍由 profile 控制

struct AodWeather {
    profile: Option<Profile>,
    geo: GeoCache,
    cache: Cache,
    last_kick: i64,
    last_sent: Option<(i64, String, i64)>, // 携带时间戳、天气文案、取整温度
}

static AOD: OnceLock<Mutex<AodWeather>> = OnceLock::new();

fn state() -> &'static Mutex<AodWeather> {
    AOD.get_or_init(|| {
        Mutex::new(AodWeather {
            profile: None,
            geo: Default::default(),
            cache: Default::default(),
            last_kick: 0,
            last_sent: None,
        })
    })
}

fn load_profile() -> Profile {
    crate::get_home_dir()
        .ok()
        .and_then(|home| {
            crate::component_library::latest(&home, WEATHER_COMPONENT)
                .ok()
                .flatten()
        })
        .and_then(|entry| {
            let bytes =
                std::fs::read(std::path::Path::new(&entry.path).join("pc/application.json"))
                    .ok()?;
            let declaration = crate::app_services::parse(&bytes, &serde_json::json!({})).ok()?;
            declaration.location
        })
        .unwrap_or_else(|| crate::location_profile::legacy().clone())
}

fn rounded(temp: f64) -> i64 {
    if temp < 0.0 {
        (temp - 0.5) as i64
    } else {
        (temp + 0.5) as i64
    }
}

/// 心跳路径调用:必须廉价(锁内读;网络在 app_weather 后台线程)。仅在数据
/// 首次可用、内容变化或超过 30 分钟未携带时返回 Some;无数据返回 None。
pub fn heartbeat_snapshot() -> Option<serde_json::Value> {
    let now = chrono::Utc::now().timestamp();
    let mut state = state().lock().ok()?;
    if state.profile.is_none() {
        state.profile = Some(load_profile());
    }
    let profile = state.profile.as_ref()?;
    if now - state.last_kick >= KICK_INTERVAL_SEC {
        state.last_kick = now;
        let mut geo = std::mem::take(&mut state.geo);
        let mut cache = std::mem::take(&mut state.cache);
        app_weather::locate_background(profile, &mut geo, now);
        if geo.location.valid() {
            app_weather::refresh_background(profile, &geo.location, &mut cache, now);
        }
        state.geo = geo;
        state.cache = cache;
    }
    let (temp, cond, _at) = app_weather::current(profile, &state.cache, now)?;
    let temp_rounded = rounded(temp);
    let fresh = match &state.last_sent {
        Some((ts, sent_cond, sent_temp)) => {
            now - ts >= KICK_INTERVAL_SEC || *sent_temp != temp_rounded || sent_cond != &cond
        }
        None => true,
    };
    if !fresh {
        return None;
    }
    state.last_sent = Some((now, cond.clone(), temp_rounded));
    Some(serde_json::json!({"tempC": temp, "cond": cond}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn reset() {
        *state().lock().unwrap() = AodWeather {
            profile: None,
            geo: Default::default(),
            cache: Default::default(),
            last_kick: 0,
            last_sent: None,
        };
    }
    fn seeded_cache(value: f64, condition: &str) -> Cache {
        let p = crate::location_profile::legacy().clone();
        let city = app_weather::Location {
            city: "北京".into(),
            lat: 39.912,
            lon: 116.401,
        };
        let now = chrono::Utc::now().timestamp();
        let mut cache = Cache {
            key: format!("{}:{:.3},{:.3}", p.key(), city.lat, city.lon),
            ..Default::default()
        };
        cache.fetched = now;
        cache.data = json!([{
            "time": chrono::DateTime::from_timestamp(now + 600, 0)
                .unwrap()
                .to_rfc3339(),
            "value": value,
            "condition": condition,
        }]);
        cache
    }
    #[test]
    fn snapshot_carries_data_dedupes_and_refreshes_on_change() {
        reset();
        // 首个心跳会触发一次后台 kick(cfg(test) 不联网);无数据时返回 None。
        assert_eq!(heartbeat_snapshot(), None);
        {
            let mut s = state().lock().unwrap();
            s.cache = seeded_cache(-3.4, "rain");
            s.last_kick = chrono::Utc::now().timestamp(); // 之后不再触发 kick
        }
        let first = heartbeat_snapshot().unwrap();
        assert_eq!(first["tempC"].as_f64().unwrap(), -3.4);
        assert!(first["cond"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(heartbeat_snapshot(), None); // 内容未变化不重复携带
        {
            let mut s = state().lock().unwrap();
            s.cache = seeded_cache(8.0, "clear");
        }
        let second = heartbeat_snapshot().unwrap();
        assert_eq!(second["tempC"].as_f64().unwrap(), 8.0);
        assert_ne!(second["cond"], first["cond"]);
    }
}
