---
name: refunds
description: Process a customer refund end to end.
metadata:
    owner: billing
---

# Refunds

Check the order, issue the refund, then send [the refund email](templates/refund-email.md).
For disputed orders, use the escalation skill.
