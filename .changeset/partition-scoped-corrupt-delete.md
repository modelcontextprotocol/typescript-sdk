---
'@modelcontextprotocol/client': patch
---

A corrupt cached document now deletes only the partition it was read from. The previous cleanup deleted both partitions, so on a shared multi-principal store one principal's corrupt private entry also evicted the healthy shared entry. Store delete failures during this cleanup are reported through the error sink instead of rejecting the read.
