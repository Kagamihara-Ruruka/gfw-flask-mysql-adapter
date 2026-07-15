# Registry module

This module owns reusable identity-based collection operations.

Domain modules must provide the key that defines equality. Registry code may
deduplicate, group, or intern values by that key, but it must not infer domain
identity from filenames, source types, or object contents.
