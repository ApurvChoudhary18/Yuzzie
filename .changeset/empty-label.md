---
"@yuzie/cli": patch
---

`yuzie label 18 ""` and `yuzie add … --label ""` say "A label cannot be empty" before sending
anything, instead of the server's "labels.3: Too small: expected string to have >=1 characters".
Label names are trimmed.
