---
"@yuzie/server": patch
---

A request body over the 1 MB limit is a 413, and one in a media type the API does not speak is a
415, instead of a 500 logged as a server fault.
