# Winnowl — Terms of Use & Acceptable Use (draft)

> Draft for the hosted service. Not legal advice — have counsel review and adapt before publishing.
> The source code is licensed separately under Apache-2.0 (see `LICENSE`); these terms only govern
> use of the hosted service.

## 1. Acceptable use

You must not, and must not permit others to:

- **Abuse the service.** Circumvent rate limits, quotas, authentication, or authorization; or
  overload the service.
- **Attack other users.** Use prompt injection or adversarial inputs embedded in code, diffs,
  issues, or comments to make the service act against another user or repository.
- **Circumvent security controls.** Bypass or disable the input guards, endpoint allowlist,
  sandbox, or any other protective mechanism of the hosted service.

## 2. Enforcement

Abuse may result in **throttling or suspension** of the offending account/actor, and termination
for cause. Nothing here limits other remedies available at law.

## 3. Data & model providers

Winnowl sends repository content only to **approved, zero-data-retention (ZDR) model endpoints**
(enforced by an allowlist). It does not use your private code to train models, and requires the
same of its model providers.

## 4. No warranty

The review is provided "as is"; findings are advisory and may contain errors or omissions. You
remain responsible for your code and merge decisions.
