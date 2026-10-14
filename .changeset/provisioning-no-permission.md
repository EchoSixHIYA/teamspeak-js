---
"@honeybbq/teamspeak-core": patch
"@honeybbq/teamspeak-client": patch
---

`ErrorCode.ProvisioningNoPermission` is 0x111a (4378), the code the server reports. It was 0x111 (273), so comparing a `ServerError`'s code with it never matched.
