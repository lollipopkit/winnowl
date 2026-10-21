# Eval data

Labelled cases for `pnpm eval:recall` and `pnpm eval:verify`, kept in the repo so a run can be repeated.

| File | Command |
| --- | --- |
| `recall-flutter_server_box-1576-2cbfd61.json` | `pnpm eval:recall lollipopkit/flutter_server_box 1576 2cbfd6102b43286d67c41d1140ae69986843818a scripts/eval-data/recall-flutter_server_box-1576-2cbfd61.json` |
| `recall-reviewbot-live-37-0cfdbc5.json` | `EVAL_FAST_MAP=1 pnpm eval:recall lollipopkit/reviewbot-live 37 0cfdbc5205e4fb817ee0d4a29586d2e7d4b2d15d scripts/eval-data/recall-reviewbot-live-37-0cfdbc5.json 3` |
| `recall-reviewbot-live-39-684dcf6.json` | `EVAL_FAST_MAP=1 pnpm eval:recall lollipopkit/reviewbot-live 39 684dcf62cdcba9128767ab1fc69cebe6b3b7b710 scripts/eval-data/recall-reviewbot-live-39-684dcf6.json 3` |
| `recall-reviewbot-live-40-952e4d4.json` | `EVAL_LANGUAGE=zh EVAL_FAST_MAP=1 pnpm eval:recall lollipopkit/reviewbot-live 40 952e4d48974d8a1b4e107f7ff3ddfe0ca8bac092 scripts/eval-data/recall-reviewbot-live-40-952e4d4.json 5` |
| `verify-flutter_server_box-1576.json` | `pnpm eval:verify lollipopkit/flutter_server_box 1576 scripts/eval-data/verify-flutter_server_box-1576.json` |

Recall gold is the list of problems that exist at that commit (CodeRabbit's inline comments for #1576).
Verify cases pair each claim with the commit it was reported on (`real`) and the commit that fixed it (`false`).
