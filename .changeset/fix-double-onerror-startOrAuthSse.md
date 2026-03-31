---
'@modelcontextprotocol/client': patch
---

Fix double `onerror` invocation when `_startOrAuthSse` fails. The internal catch block fired `onerror` then threw, and all callers already `.catch(onerror)`, causing every failure to fire twice. Removed the redundant internal call.
