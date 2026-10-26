# IM admission compatibility fixtures

Upstream snapshots used only by isolated compatibility tests. Versions and hashes below identify the fixtures, not a runtime allowlist. Tests also vary surrounding code, comments and formatting to cover plugin upgrades. Compressed fixtures avoid copying large monitor modules into the test body. Tests execute only the transformed admission boundary with synthetic callbacks; no vendor gateway is started.

| Package | Version | Fixture | Source SHA-256 |
|---|---|---|---|
| `@wecom/wecom-openclaw-plugin` | `2026.9.15` | `wecom-chat-queue-2026.9.15.txt` | `7b8a3aa49abd854d171101ea9a485406ed8d895ceca423c2f35947ceb9911677` |
| `@tencent-weixin/openclaw-weixin` | `2.4.10` | `weixin-monitor.ts.gz` | `a8689853b464cea3bd12932fc97055dbcac2ec1386d1a7a39a81cb8e291f3704` |
| `@sliverp/qqbot` | `1.6.1` | `qq-gateway.ts.gz` | `26aa19501f938edd83ef6f9d224488dd2075c85a2f3713ee771b40421b68f632` |

The copied Weixin and QQ modules retain their upstream MIT notices in [weixin-LICENSE.txt](weixin-LICENSE.txt) and [qq-LICENSE.txt](qq-LICENSE.txt), extracted from each version's npm `package/LICENSE` with only trailing whitespace normalized.
