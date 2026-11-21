cmake_minimum_required(VERSION 3.16)
project(petui_wasm_check C ASM)

# runner 的 cl 默认老 C 模式：不认 _Static_assert 关键字（LNK2019）。显式 C17。
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(host "${CMAKE_CURRENT_LIST_DIR}/../../components/hachi_wamr")
include("${host}/wamr-options.cmake")
# Use the same software bounds checks as the embedded interpreter.
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
set(WAMR_ROOT_DIR "$ENV{WAMR_ROOT}")
if(NOT EXISTS "${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake")
  message(FATAL_ERROR "Set WAMR_ROOT to the WAMR source used for the device firmware")
endif()

# Runner MSVC 在 WASM_ENABLE_MODULE_INST_CONTEXT 与 WASM_CONFIGURABLE_BOUNDS_CHECKS
# 都为 0 时把 WASMModuleInstanceExtraCommon 编译成空结构体（C2016，/std:c20 也无效）。
# C2x 允许空结构体，但 runner 的 cl 不认识任何 /std 选项；在 configure 期补一个成员。
if(MSVC)
  file(READ "${WAMR_ROOT_DIR}/core/iwasm/interpreter/wasm_runtime.h" _wamr_header)
  string(FIND "${_wamr_header}" "typedef struct WASMModuleInstanceExtraCommon {" _has_struct)
  if(_has_struct GREATER_EQUAL 0)
    string(REPLACE
      "typedef struct WASMModuleInstanceExtraCommon {"
      "typedef struct WASMModuleInstanceExtraCommon {
    char _msvc_empty_struct_pad;"
      _wamr_header_patched "${_wamr_header}")
    file(WRITE "${WAMR_ROOT_DIR}/core/iwasm/interpreter/wasm_runtime.h" "${_wamr_header_patched}")
  endif()
endif()
if(APPLE)
  set(WAMR_BUILD_PLATFORM darwin)
elseif(WIN32)
  set(WAMR_BUILD_PLATFORM windows)
else()
  set(WAMR_BUILD_PLATFORM linux)
endif()
include("${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake")
add_executable(petui-wasm-check main.c "${host}/hachi_runtime.c" ${WAMR_RUNTIME_LIB_SOURCE})
target_include_directories(petui-wasm-check PRIVATE "${host}" "${IWASM_DIR}/include")
if(MINGW)
  target_link_options(petui-wasm-check PRIVATE -static)
endif()
if(WIN32)
  target_link_libraries(petui-wasm-check PRIVATE ws2_32 ntdll)
elseif(UNIX)
  target_link_libraries(petui-wasm-check PRIVATE m pthread ${CMAKE_DL_LIBS})
endif()
