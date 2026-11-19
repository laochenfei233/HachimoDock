# ESP32-P4 WLK2802 Display BSP

This local Waveshare BSP adaptation drives the 480x640 WLK2802/ST7701S panel
over one 800Mbps MIPI DSI data lane. The firmware renders a 640x480 logical
framebuffer and rotates it onto the portrait panel.

DSI PHY clock selection is left to the SDK (`phy_clk_src = 0`) so each
chip family uses its supported PLL reference. The old explicit PHY default
is invalid on P4 v3. Lane rate, rotation, RGB565 format and resolution are unchanged.

P4 v3 uses an exact 24MHz DPI clock (240MHz / 10). Requesting 25MHz with
IDF 5.5.4 produces 24MHz and a horizontal timing correction of -21 pixels,
which exceeds this panel's 10-pixel front porch and prevents normal scanout.
The v1 build retains its existing 25MHz request and SDK timing behavior.

The panel command return path is treated as write-only. Startup skips the
optional ST7701S ID read and disables command ACK requests before sending the
vendor initialization table. Waiting for either response can otherwise fill
the ESP32-P4 command FIFO and block startup before the backlight is enabled.

## Backlight

```c
bsp_display_brightness_init();
bsp_display_backlight_on();
bsp_display_backlight_off();
bsp_display_brightness_set(100);
```

## Dependencies

| Capability | Implementation |
|---|---|
| Display | Local `esp_lcd_st7701` 2.0.2 override |
| Touch | `espressif/esp_lcd_touch_gt911` |
| Audio | `espressif/esp_codec_dev` |
| SD card | ESP-IDF |

The WLK2802MIPI-15P-V2 module is marked `ST7701S 1Lane MIPI` and the
LCD connector exposes only D0 and the clock. Use one data lane at
800 Mbps for this module, including when it is attached through its
22-pin adapter connector. On the same device, a 550 Mbps single-lane
test showed a stable image, while dual-lane tests at 500 and 550 Mbps
left the LCD blank.

For a module wired for two data lanes, select
`CONFIG_BSP_LCD_DSI_DATA_LANES=2` only after checking both DSI data pairs
through the adapter/FPC and confirming that the ST7701S module selects
two lanes (LANSEL high). Two-lane evaluation uses 500 Mbps per lane with
the existing pixel clock and panel timings.

Use the same content and measure `renderSubmittedFrames` deltas over a fixed
interval for 1-lane and 2-lane with the same render interval. To evaluate
render scheduling separately, set `CONFIG_PET_P4_MAIN_RENDER_INTERVAL_MS=33`.
The desktop client can read lane count, per-lane bitrate, pixel clock and
target interval from `diagnostics/status.runtime`.

In the local firmware builder, use `--lcd-lanes 2` for the dual-lane profile
and `--render-interval-ms 33` for the faster render interval. Experimental
profiles have separate output paths. `--lcd-lane-mbps` can vary the lane
rate within the ST7701S limits of 800 Mbps for one lane and 550 Mbps per
lane for two lanes.

For a hardware comparison, sample the same device and animation with
`firmware/tools/runtime_memory_probe.py` over matching time windows. It records
the active build, display profile and frame counters. Check the physical LCD
for correct colors and stable output after a cold boot and during animation.
Keep USB available with a compatible single-lane recovery image: OTA runtime
validation observes framebuffer submission, which can succeed with a blank LCD.
