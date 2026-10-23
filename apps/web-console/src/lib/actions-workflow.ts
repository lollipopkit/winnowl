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
      - uses: lollipopkit/winnowl@main
        with:
          llm-api-key: \${{ secrets.WINNOWL_LLM_API_KEY }}
          # Optional: your endpoint and one model for every stage.
          # llm-base-url: https://api.openai.com/v1
          # llm-model: gpt-6-luna
`;
