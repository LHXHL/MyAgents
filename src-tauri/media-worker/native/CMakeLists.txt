cmake_minimum_required(VERSION 3.28)
project(myagents_speech_adapter LANGUAGES CXX)

include(CTest)
if(BUILD_TESTING)
  add_executable(speech-vad-bound-test bounded_vad_test.cc)
  target_compile_features(speech-vad-bound-test PRIVATE cxx_std_20)
  # Assertions are the regression checks, including in Release test builds.
  if(MSVC)
    target_compile_options(speech-vad-bound-test PRIVATE /UNDEBUG)
  else()
    target_compile_options(speech-vad-bound-test PRIVATE -UNDEBUG)
  endif()
  add_test(NAME speech-vad-bound COMMAND speech-vad-bound-test)
endif()

foreach(required IN ITEMS MYAGENTS_SHERPA_INCLUDE_DIR MYAGENTS_SHERPA_LIBRARY MYAGENTS_HCLUST_INCLUDE_DIR)
  if(NOT DEFINED ${required} OR "${${required}}" STREQUAL "")
    message(FATAL_ERROR "${required} is required")
  endif()
endforeach()

add_library(myagents-speech-adapter SHARED myagents_speech_adapter.cc)
target_compile_features(myagents-speech-adapter PRIVATE cxx_std_20)
target_compile_definitions(
  myagents-speech-adapter
  PRIVATE MYAGENTS_SHERPA_ONNX_COMMIT="1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911"
)
target_include_directories(
  myagents-speech-adapter
  PRIVATE "${MYAGENTS_SHERPA_INCLUDE_DIR}"
)
target_include_directories(
  myagents-speech-adapter
  SYSTEM PRIVATE "${MYAGENTS_HCLUST_INCLUDE_DIR}"
)
target_link_libraries(
  myagents-speech-adapter
  PRIVATE "${MYAGENTS_SHERPA_LIBRARY}"
)
set_target_properties(
  myagents-speech-adapter
  PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES
    BUILD_WITH_INSTALL_RPATH YES
)

if(APPLE)
  set_target_properties(
    myagents-speech-adapter
    PROPERTIES
      INSTALL_NAME_DIR "@rpath"
      INSTALL_RPATH "@loader_path"
  )
elseif(UNIX)
  set_target_properties(
    myagents-speech-adapter
    PROPERTIES INSTALL_RPATH "$ORIGIN"
  )
endif()

if(MSVC)
  target_compile_options(myagents-speech-adapter PRIVATE /W4 /WX /EHsc /utf-8)
else()
  target_compile_options(
    myagents-speech-adapter
    PRIVATE -Wall -Wextra -Werror
  )
endif()
