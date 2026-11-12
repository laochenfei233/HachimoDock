//! One-shot AOD 息屏配置 RPC(set 配置 / enter 立即息屏)。无传输回退、无重放:
//! 结果未知时以回执为准,超时不重发。镜像 master_volume 的绑定与校验结构。
use super::*;

// Kept std-only so the validation tests can run directly with rustc, without
// building the concurrently edited application or copying its test resources.
mod policy {
    pub(crate) const ENGINE: &str = "p4-display-aod-v1";
    pub(super) const ITEM_NAMES: [&str; 5] = ["none", "time", "date", "weather", "agent"];

    pub(super) fn board(value: &str) -> Result<&str, &'static str> {
        if value.is_empty()
            || value.len() > 64
            || value.trim() != value
            || value.chars().any(char::is_control)
        {
            return Err("invalid expectedBoardDeviceId");
        }
        Ok(value)
    }

    pub(super) fn timeout(value: Option<u16>) -> Result<(), &'static str> {
        if value.is_some_and(|v| v > 1440) {
            return Err("timeoutMinutes must be an integer from 0 to 1440");
        }
        Ok(())
    }

    pub(super) fn item_valid(name: &str) -> bool {
        ITEM_NAMES.contains(&name)
    }

    /// set:0-2 个合法且非 none 不重复的项;enter:不带 items。
    pub(super) fn items(value: Option<&[String]>) -> Result<(), &'static str> {
        let Some(list) = value else {
            return Ok(());
        };
        if list.len() > 2 {
            return Err("items must hold at most two entries");
        }
        for (index, name) in list.iter().enumerate() {
            if !item_valid(name) {
                return Err("items holds an unknown entry");
            }
            if name != "none" && list[..index].contains(name) {
                return Err("items repeats a non-none entry");
            }
        }
        Ok(())
    }

    pub(super) fn session(
        expected: &str,
        generation: u64,
        actual: &str,
        actual_generation: u64,
        connected: bool,
        cancelled: bool,
        current: bool,
        capability: Option<&str>,
    ) -> Result<(), &'static str> {
        board(expected)?;
        if generation == 0
            || generation != actual_generation
            || expected != actual
            || !connected
            || cancelled
            || !current
        {
            return Err("display aod connection retired or changed");
        }
        if capability != Some(ENGINE) {
            return Err("display aod capability unavailable");
        }
        Ok(())
    }

    pub(super) struct Receipt<'a> {
        pub ok: Option<bool>,
        pub engine: Option<&'a str>,
        pub board: Option<&'a str>,
        pub request: Option<&'a str>,
        pub timeout: Option<u64>,
        pub items_valid: bool,
        pub persisted: Option<bool>,
        pub active: Option<bool>,
        pub optional_fields_valid: bool,
    }
    pub(super) fn receipt(
        value: Receipt<'_>,
        expected: &str,
        request: &str,
        set_timeout: Option<u16>,
    ) -> Result<(), &'static str> {
        if value.ok != Some(true)
            || value.engine != Some(ENGINE)
            || value.board != Some(expected)
            || request.is_empty()
            || value.request != Some(request)
            || value.persisted.is_none()
            || value.active.is_none()
            || !value.items_valid
            || !value.optional_fields_valid
        {
            return Err("invalid display aod receipt");
        }
        let timeout = value
            .timeout
            .filter(|v| *v <= 1440)
            .ok_or("display aod timeout unknown")?;
        if set_timeout.is_some_and(|v| u64::from(v) != timeout) {
            return Err("display aod set echo mismatch");
        }
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn reply() -> Receipt<'static> {
            Receipt {
                ok: Some(true),
                engine: Some(ENGINE),
                board: Some("board"),
                request: Some("request"),
                timeout: Some(5),
                items_valid: true,
                persisted: Some(true),
                active: Some(false),
                optional_fields_valid: true,
            }
        }
        #[test]
        fn exact_board_engine_request_items_and_flags_are_required() {
            assert!(receipt(reply(), "board", "request", None).is_ok());
            for field in 0..8 {
                let mut r = reply();
                match field {
                    0 => r.board = None,
                    1 => r.board = Some("other"),
                    2 => r.engine = None,
                    3 => r.engine = Some("other"),
                    4 => r.request = Some("other"),
                    5 => r.persisted = None,
                    6 => r.active = None,
                    _ => r.items_valid = false,
                };
                assert!(receipt(r, "board", "request", None).is_err());
            }
        }
        #[test]
        fn unknown_out_of_range_and_wrong_set_echo_are_not_success() {
            for v in [None, Some(1441), Some(u64::MAX)] {
                let mut r = reply();
                r.timeout = v;
                assert!(receipt(r, "board", "request", None).is_err());
            }
            assert!(receipt(reply(), "board", "request", Some(10)).is_err());
            assert!(receipt(reply(), "board", "request", Some(5)).is_ok());
        }
        #[test]
        fn input_boundaries_are_not_clamped() {
            assert!(timeout(Some(0)).is_ok());
            assert!(timeout(Some(1440)).is_ok());
            assert!(timeout(Some(1441)).is_err());
            assert!(items(None).is_ok());
            assert!(items(Some(&[])).is_ok());
            assert!(items(Some(&["time".into(), "date".into()])).is_ok());
            assert!(items(Some(&["none".into(), "none".into()])).is_ok());
            assert!(items(Some(&["time".into(), "time".into()])).is_err());
            assert!(items(Some(&["time".into(), "date".into(), "weather".into()])).is_err());
            assert!(items(Some(&["mood".into()])).is_err());
        }
    }
}
pub(crate) use policy::ENGINE;
const RESPONSE_TOPIC: &str = "display/aod-state";
const UNKNOWN: &str = "display_aod_result_unknown_refresh_required";

fn check_connection(
    manager: &UsbSerialManager,
    connection: &UsbConnection,
    board: &str,
    generation: u64,
) -> Result<(), String> {
    policy::session(
        board,
        generation,
        &connection.board_device_id,
        connection.connection_id,
        connection.connected,
        connection.cancel_reader.load(Ordering::Acquire),
        manager.inbound_owner.is_current(generation),
        connection.capabilities["displayAod"].as_str(),
    )
    .map_err(str::to_owned)
}

/// Rechecked while send_inner owns both the inbound lease and connection lock.
/// Generic/unbound sends cannot obtain the trusted AOD control path.
pub(super) fn validate_write(
    connection: &UsbConnection,
    board: Option<&str>,
    generation: Option<u64>,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let board = board.ok_or("display aod requires an exact board binding")?;
    let generation = generation
        .filter(|v| *v != 0)
        .ok_or("display aod requires a connection generation")?;
    if connection.connection_id != generation
        || connection.board_device_id != board
        || connection.capabilities["displayAod"] != ENGINE
    {
        return Err("display aod binding or capability changed; not submitted".into());
    }
    let object = payload.as_object().ok_or("invalid display aod request")?;
    let set = match payload["operation"].as_str() {
        Some("enter") => false,
        Some("set") => true,
        _ => return Err("invalid display aod operation".into()),
    };
    let timeout = payload["timeoutMinutes"].as_u64();
    let items = payload["items"].as_array();
    let items_ok = items.is_some_and(|list| {
        let names: Option<Vec<&str>> = list.iter().map(|v| v.as_str()).collect();
        names.is_some_and(|names| {
            policy::items(Some(
                &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ))
            .is_ok()
        })
    });
    if object.len() != if set { 5 } else { 3 }
        || payload["expectedBoardDeviceId"].as_str() != Some(board)
        || !payload["requestId"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 96 && !v.chars().any(char::is_control))
        || (set && (!timeout.is_some_and(|v| v <= 1440) || !items_ok))
        || (!set && (object.contains_key("timeoutMinutes") || object.contains_key("items")))
    {
        return Err("invalid display aod request".into());
    }
    Ok(())
}

fn validate_response(
    response: &serde_json::Value,
    board: &str,
    request: &str,
    set_timeout: Option<u16>,
) -> Result<(), String> {
    let items_valid = response["items"].as_array().is_some_and(|list| {
        let names: Option<Vec<&str>> = list.iter().map(|v| v.as_str()).collect();
        names.is_some_and(|names| {
            policy::items(Some(
                &names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ))
            .is_ok()
        })
    });
    policy::receipt(
        policy::Receipt {
            ok: response["ok"].as_bool(),
            engine: response["engine"].as_str(),
            board: response["boardDeviceId"].as_str(),
            request: response["requestId"].as_str(),
            timeout: response["timeoutMinutes"].as_u64(),
            items_valid,
            persisted: response["persisted"].as_bool(),
            active: response["active"].as_bool(),
            optional_fields_valid: response.get("error").is_none_or(|v| {
                v.as_str()
                    .is_some_and(|s| !s.is_empty() && s.chars().count() <= 64)
            }),
        },
        board,
        request,
        set_timeout,
    )
    .map_err(str::to_owned)
}

impl UsbSerialManager {
    /// timeout 为 Some 时下发 set 配置(None 时下发 enter 立即息屏)。
    pub fn display_aod(
        &self,
        board: &str,
        timeout: Option<u16>,
        items: Option<Vec<String>>,
    ) -> Result<serde_json::Value, String> {
        self.display_aod_timeout(board, timeout, items, P4_DEVICE_RESPONSE_TIMEOUT)
    }
    fn display_aod_timeout(
        &self,
        board: &str,
        timeout: Option<u16>,
        items: Option<Vec<String>>,
        timeout_duration: Duration,
    ) -> Result<serde_json::Value, String> {
        policy::board(board).map_err(str::to_owned)?;
        policy::timeout(timeout).map_err(str::to_owned)?;
        if timeout.is_some() {
            policy::items(items.as_deref()).map_err(str::to_owned)?;
        } else if items.is_some() {
            return Err("enter must not carry items".into());
        }
        let _bulk = self
            .asset_transfer_guard
            .try_lock()
            .map_err(|_| "device transfer busy; display aod not submitted")?;
        let (generation, cancel) = {
            let (_lease, slot) = self.inbound_owner.connection(&self.connection)?;
            let connection = slot.as_ref().ok_or("USB is not connected")?;
            check_connection(self, connection, board, connection.connection_id)?;
            (connection.connection_id, connection.cancel_reader.clone())
        };
        let request = format!("aod-{}", uuid::Uuid::new_v4());
        let mut payload = serde_json::json!({"operation":if timeout.is_some(){"set"}else{"enter"},
            "requestId":request,"expectedBoardDeviceId":board});
        if let Some(timeout) = timeout {
            payload["timeoutMinutes"] = timeout.into();
            payload["items"] = serde_json::json!(items.unwrap_or_default());
        }
        let (sender, receiver) = mpsc::channel();
        self.device_response_waiters
            .lock()
            .map_err(|_| "display aod receipt queue unavailable")?
            .push(DeviceResponseWaiter {
                request_id: request.clone(),
                response_topic: RESPONSE_TOPIC.into(),
                sender,
            });
        // Exactly one logical send; unknown delivery never replays a set.
        let sent = self.send_inner(
            "display/aod",
            &payload,
            true,
            Some(board),
            Some(generation),
            None,
        );
        let response = match sent {
            Ok(()) => receiver
                .recv_timeout(timeout_duration)
                .map_err(|_| format!("{UNKNOWN}: receipt unavailable")),
            Err(_) => Err(format!("{UNKNOWN}: submission unconfirmed")),
        };
        self.remove_device_response_waiter(&request, RESPONSE_TOPIC);
        let response = response?;
        validate_response(&response, board, &request, timeout)
            .map_err(|e| format!("{UNKNOWN}: {e}"))?;
        // Linearize success under the same owner gate as inbound dispatch.
        {
            let (_lease, slot) = self
                .inbound_owner
                .connection(&self.connection)
                .map_err(|_| format!("{UNKNOWN}: owner unavailable"))?;
            let connection = slot
                .as_ref()
                .ok_or_else(|| format!("{UNKNOWN}: disconnected"))?;
            if cancel.load(Ordering::Acquire) || !Arc::ptr_eq(&cancel, &connection.cancel_reader) {
                return Err(format!("{UNKNOWN}: connection cancelled"));
            }
            check_connection(self, connection, board, generation)
                .map_err(|e| format!("{UNKNOWN}: {e}"))?;
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[derive(Clone, Copy)]
    enum Mode {
        Reply,
        WrongBoard,
        WrongEcho,
        Null,
        Drop,
    }
    struct MemoryWriter {
        pending: Vec<u8>,
        trace: Arc<Mutex<Vec<Value>>>,
        waiters: Arc<Mutex<Vec<DeviceResponseWaiter>>>,
        owner: Arc<inbound_owner::Owner>,
        mode: Mode,
    }
    impl Write for MemoryWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.pending.extend_from_slice(bytes);
            while let Some(end) = self.pending.iter().position(|v| *v == b'\n') {
                let line = self.pending.drain(..=end).collect::<Vec<_>>();
                let request: Value = serde_json::from_slice(&line).unwrap();
                self.trace.lock().unwrap().push(request.clone());
                let p = &request["payload"];
                if matches!(self.mode, Mode::Drop) {
                    continue;
                }
                let mut response = json!({"ok":true,"engine":ENGINE,"boardDeviceId":"aod-board",
                    "requestId":p["requestId"],
                    "timeoutMinutes":p.get("timeoutMinutes").cloned().unwrap_or(json!(5)),
                    "items":["time","date"],"persisted":true,"active":true});
                match self.mode {
                    Mode::WrongBoard => response["boardDeviceId"] = json!("other"),
                    Mode::WrongEcho => response["timeoutMinutes"] = json!(9),
                    Mode::Null => response["persisted"] = Value::Null,
                    _ => {}
                }
                resolve_device_response(&self.waiters, RESPONSE_TOPIC, &response);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("display aod must use the live path without draining")
        }
    }
    fn manager(mode: Mode) -> (UsbSerialManager, Arc<Mutex<Vec<Value>>>) {
        let manager = UsbSerialManager::new();
        let trace = Arc::new(Mutex::new(vec![]));
        let cancel = Arc::new(AtomicBool::new(false));
        *manager.connection.lock().unwrap() = Some(UsbConnection {
            connection_id: 1,
            port_name: "memory-only-aod".into(),
            baud_rate: 115200,
            writer: Box::new(MemoryWriter {
                pending: vec![],
                trace: trace.clone(),
                waiters: manager.device_response_waiters.clone(),
                owner: manager.inbound_owner.clone(),
                mode,
            }),
            board_device_id: "aod-board".into(),
            runtime: "esp-p4".into(),
            device_model: String::new(),
            firmware: String::new(),
            build_id: String::new(),
            git_sha: String::new(),
            build_dirty: false,
            protocol_schema: 7,
            wire_protocol: String::new(),
            capabilities: json!({"displayAod":ENGINE}),
            connected: true,
            cancel_reader: cancel,
            capture_active: Arc::new(AtomicBool::new(true)),
        });
        {
            let _owner = manager.inbound_owner.lock().unwrap();
            manager.inbound_owner.publish(1);
        }
        (manager, trace)
    }
    #[test]
    fn memory_set_and_enter_are_bound_one_shot_with_echo_check() {
        let (manager, trace) = manager(Mode::Reply);
        let result = manager
            .display_aod_timeout(
                "aod-board",
                Some(10),
                Some(vec!["time".into(), "weather".into()]),
                Duration::from_millis(20),
            )
            .unwrap();
        assert_eq!(result["timeoutMinutes"], 10);
        assert_eq!(result["active"], true);
        {
            let trace = trace.lock().unwrap();
            assert_eq!(trace.len(), 1);
            assert_eq!(trace[0]["topic"], "display/aod");
            assert_eq!(trace[0]["payload"]["operation"], "set");
            assert_eq!(trace[0]["payload"]["timeoutMinutes"], 10);
        }
        let result = manager
            .display_aod_timeout("aod-board", None, None, Duration::from_millis(20))
            .unwrap();
        assert_eq!(result["timeoutMinutes"], 5);
        assert!(manager.device_response_waiters.lock().unwrap().is_empty());
    }
    #[test]
    fn memory_bad_receipts_report_unknown_without_retry() {
        for mode in [Mode::WrongBoard, Mode::WrongEcho, Mode::Null, Mode::Drop] {
            let (manager, trace) = manager(mode);
            let error = manager
                .display_aod_timeout(
                    "aod-board",
                    Some(30),
                    Some(vec!["time".into()]),
                    Duration::from_millis(10),
                )
                .unwrap_err();
            assert!(error.starts_with(UNKNOWN), "{error}");
            assert_eq!(trace.lock().unwrap().len(), 1);
            assert!(manager.device_response_waiters.lock().unwrap().is_empty());
        }
    }
    #[test]
    fn json_receipt_rejects_unknown_items_and_bad_echo() {
        let base = json!({"ok":true,"engine":ENGINE,"boardDeviceId":"aod-board","requestId":"request",
            "timeoutMinutes":5,"items":["time","none"],"persisted":true,"active":false});
        assert!(validate_response(&base, "aod-board", "request", Some(5)).is_ok());
        for mutation in 0..3 {
            let mut reply = base.clone();
            match mutation {
                0 => reply["items"] = json!(["mood"]),
                1 => reply["items"] = json!([]),
                _ => reply["timeoutMinutes"] = json!(1441),
            };
            assert!(validate_response(&reply, "aod-board", "request", None).is_err());
        }
    }
    #[test]
    fn validate_write_requires_binding_capability_and_exact_fields() {
        let (manager, trace) = manager(Mode::Reply);
        let connection = manager.connection.lock().unwrap();
        let connection = connection.as_ref().unwrap();
        let set = json!({"operation":"set","requestId":"r","expectedBoardDeviceId":"aod-board",
            "timeoutMinutes":5,"items":["time","date"]});
        assert!(validate_write(connection, Some("aod-board"), Some(1), &set).is_ok());
        let enter =
            json!({"operation":"enter","requestId":"r","expectedBoardDeviceId":"aod-board"});
        assert!(validate_write(connection, Some("aod-board"), Some(1), &enter).is_ok());
        assert!(validate_write(connection, None, Some(1), &set).is_err());
        assert!(validate_write(connection, Some("aod-board"), None, &set).is_err());
        assert!(validate_write(connection, Some("aod-board"), Some(2), &set).is_err());
        for case in 0..4 {
            let mut bad = set.clone();
            match case {
                0 => bad["timeoutMinutes"] = json!(1441),
                1 => bad["items"] = json!(["time", "time"]),
                2 => bad["items"] = json!(["time", "date", "weather"]),
                _ => {
                    bad.as_object_mut().unwrap().remove("items");
                }
            };
            assert!(validate_write(connection, Some("aod-board"), Some(1), &bad).is_err());
        }
        let mut enter_extra = enter.clone();
        enter_extra["timeoutMinutes"] = json!(5);
        assert!(validate_write(connection, Some("aod-board"), Some(1), &enter_extra).is_err());
        assert!(trace.lock().unwrap().is_empty());
    }
}
