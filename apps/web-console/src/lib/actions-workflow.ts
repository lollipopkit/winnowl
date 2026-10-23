/** The workflow a repository adds to run reviews in its own GitHub Actions (`sandbox.runner: actions`). */
export const ACTIONS_WORKFLOW_PATH = '.github/workflows/winnowl.yml';

export const ACTIONS_WORKFLOW = `name: winnowl
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  id-token: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # Set up the toolchains review commands need to build and test (for example actions/setup-node).
      - uses: lollipopkit/winnowl@main
        with:
          llm-api-key: \${{ secrets.WINNOWL_LLM_API_KEY }}
          # Your endpoint; empty uses the provider's default.
          # llm-base-url: https://api.openai.com/v1
          # One model your endpoint serves, for every stage.
          llm-model: gpt-6-luna
`;
