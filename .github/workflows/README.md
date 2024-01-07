# Github Actions

This directory contains [Github Actions](https://help.github.com/en/actions) workflows
used for testing.

## Workflows

- `node-test.yml` - unit tests and integration tests.

## Secrets

The following secrets must be defined on the project:

| novo                          | Description                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `FBTOOLS_TARGET_PROJECT`      |  project id c539f8ed6df9cb48e6fc                        |
| `service_account_json_base64` | A base64-encoded service account JSON file with access to the selected project |
