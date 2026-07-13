# Endpoint module

This module owns external HTTP data-source contracts. A source config supplies
transport settings such as host, port, base path and authentication. Contract
adapters inspect the remote catalog and derive runtime datasets and layer
capabilities without exposing the remote query engine to the dashboard.

Dataset-specific query and geometry adapters must be compiled from a published
wire contract. They must not infer or depend on the provider's internal table,
Parquet or Iceberg schema.
