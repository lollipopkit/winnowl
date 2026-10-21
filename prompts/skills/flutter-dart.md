---
name: flutter-dart
description: Flutter and Dart — widget lifecycle, BuildContext after await, dispose, setState, async and isolates.
---
- `BuildContext` used after an `await` without checking `context.mounted` (or `mounted` in a
  `State`): navigation, dialogs, `ScaffoldMessenger`, `Theme.of` on a disposed element.
- `setState` called after `dispose`, or from callbacks (timers, streams, futures) that outlive the
  widget.
- Controllers and notifiers (`TextEditingController`, `AnimationController`, `ScrollController`,
  `FocusNode`, `StreamSubscription`, `ChangeNotifier` listeners) created in `initState` or build and
  not disposed or cancelled.
- Work or side effects in `build` (network calls, controller creation, `setState`) that runs on
  every rebuild.
- Keys: lists of stateful children without stable keys, so state moves between items.
- Async: unawaited futures whose errors are lost; `Future.wait` failing fast and leaving others
  running; heavy synchronous work on the UI isolate.
- Platform channels and plugins: calls without handling `MissingPluginException` or platform
  differences the change assumes away.

A finding names the widget, the lifecycle moment, and the user-visible failure (exception, stale
state, leak).
