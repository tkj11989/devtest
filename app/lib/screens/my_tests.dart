import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';
import '../app_launcher.dart';

const _dayMs = 86400000;
const _activeStatuses = ['joined', 'installed', 'active'];
const _installedStatuses = ['installed', 'active'];

String _until(int ms) {
  final d = Duration(milliseconds: ms < 0 ? 0 : ms);
  return '${d.inHours}h ${(d.inMinutes % 60).toString().padLeft(2, '0')}m';
}

/// The tester's packages: install period (buffer timer + automatic install check), then 16 days of
/// 24-hour days with a daily 30-second test.
class MyTestsScreen extends StatefulWidget {
  const MyTestsScreen({super.key});
  @override
  State<MyTestsScreen> createState() => _MyTestsScreenState();
}

class _MyTestsScreenState extends State<MyTestsScreen> with WidgetsBindingObserver {
  Map? session; // open 30-second test: {sessionId, poolId, packageName, minSeconds}
  Timer? tick;
  List<Map<String, dynamic>> memberships = [];
  final Map<String, String?> _pkgByApp = {};
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Refresh countdowns and re-check installs regularly while this screen is open.
    tick = Timer.periodic(const Duration(seconds: 20), (_) {
      checkInstalls();
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    tick?.cancel();
    super.dispose();
  }

  void snack(String text) {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (session != null) {
      finishTest();
    } else {
      checkInstalls(); // back from the Play Store: was the app installed?
    }
  }

  Future<String?> _pkg(String appId) async =>
      _pkgByApp[appId] ??= (await Api.db.collection('apps').doc(appId).get()).data()?['packageName'] as String?;

  /// Looks for each joined package on this phone and reports installs to the backend. Also nudges pools whose
  /// install timer has run out so they move on (start testing, or reopen for joins).
  Future<void> checkInstalls() async {
    if (_checking) return;
    _checking = true;
    try {
      for (final m in List.of(memberships)) {
        final poolId = m['poolId'] as String;
        if (m['status'] == 'joined') {
          final pkg = await _pkg(m['appId']);
          if (pkg != null && await AppLauncher.isInstalled(pkg)) {
            final r = await Api.confirmInstalled(poolId);
            snack(r['state'] == 'running' || r['state'] == 'at_risk'
                ? 'Install confirmed. Everyone is ready: testing has started.'
                : 'Install confirmed for $pkg.');
          }
        }
        final pool = (await Api.db.collection('pools').doc(poolId).get()).data();
        final deadline = pool?['installDeadline'] as int?;
        if (pool?['state'] == 'installing' && deadline != null && deadline <= DateTime.now().millisecondsSinceEpoch) {
          await Api.refreshPool(poolId);
        }
      }
    } catch (e) {
      snack(friendly(e));
    } finally {
      _checking = false;
    }
  }

  Future<void> openStore(String pkg) async {
    final market = Uri.parse('market://details?id=$pkg');
    if (!await launchUrl(market, mode: LaunchMode.externalApplication)) {
      await launchUrl(Uri.parse('https://play.google.com/store/apps/details?id=$pkg'), mode: LaunchMode.externalApplication);
    }
  }

  /// Daily test, step 1: server-stamped session, then open the app under test.
  Future<void> startTest(String poolId) async {
    try {
      final s = await Api.startTest(poolId);
      final pkg = s['packageName'] as String?;
      if (pkg == null || !await AppLauncher.isInstalled(pkg)) {
        snack('The app is not installed on this phone any more. Reinstall it to continue testing.');
        return;
      }
      session = {...s, 'poolId': poolId};
      await AppLauncher.launch(pkg);
    } catch (e) {
      snack(friendly(e));
    }
  }

  /// Daily test, step 2: back in our app, the server checks that 30 seconds have passed.
  Future<void> finishTest() async {
    final s = session!;
    try {
      final r = await Api.finishTest(s['sessionId']);
      if (r['recorded'] == true) {
        session = null;
        snack('Day ${r['day']} recorded: you tested for ${r['seconds']} s.');
      } else if (r['reason'] == 'too_short') {
        if (!mounted) return;
        final again = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: const Text('Keep testing'),
            content: Text('You used the app for ${r['seconds']} s. Use it for at least ${r['minSeconds']} s '
                'for today to count.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Later')),
              FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Continue testing')),
            ],
          ),
        );
        if (again == true) {
          await AppLauncher.launch(s['packageName']); // same session: the time keeps counting
        } else {
          session = null;
        }
      } else {
        session = null;
        snack(r['reason'] == 'already_tested_today'
            ? 'Today\'s test was already recorded.'
            : 'That test session expired. Tap "Test app" to start again.');
      }
    } catch (e) {
      session = null;
      snack(friendly(e));
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        stream: Api.me(),
        builder: (_, me) => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
          stream: Api.myMemberships(),
          builder: (_, s) {
            final active = (s.data?.docs ?? []).map((d) => d.data()).where((m) => _activeStatuses.contains(m['status'])).toList();
            final firstLoad = memberships.isEmpty && active.isNotEmpty;
            memberships = active;
            if (firstLoad) WidgetsBinding.instance.addPostFrameCallback((_) => checkInstalls());
            return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
              _LimitHeader(used: active.length, user: me.data?.data()),
              if (active.isEmpty)
                const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Join a package from Browse to start testing.'))),
              for (final m in active)
                _TestCard(m, onTest: () => startTest(m['poolId']), onStore: openStore, onCheck: checkInstalls),
            ]);
          },
        ),
      );
}

/// "Packages: 1 of 2". The limit is the user's own override, else the platform default in config/limits.
class _LimitHeader extends StatelessWidget {
  final int used;
  final Map<String, dynamic>? user;
  const _LimitHeader({required this.used, required this.user});
  @override
  Widget build(BuildContext context) => FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        future: Api.db.doc('config/limits').get(),
        builder: (_, cfg) {
          final limit = user?['maxTesterPools'] ?? cfg.data?.data()?['maxTesterPools'] ?? 2;
          return ListTile(
            leading: const Icon(Icons.inventory_2_outlined),
            title: Text('Packages: $used of $limit'),
            subtitle: const Text('Install each app during its install period, then test it for at least 30 seconds every day (24 hours).'),
          );
        },
      );
}

class _TestCard extends StatelessWidget {
  final Map<String, dynamic> m;
  final VoidCallback onTest;
  final Future<void> Function() onCheck;
  final Future<void> Function(String pkg) onStore;
  const _TestCard(this.m, {required this.onTest, required this.onStore, required this.onCheck});

  @override
  Widget build(BuildContext context) {
    final poolId = m['poolId'] as String;
    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: Api.db.collection('pools').doc(poolId).snapshots(),
      builder: (_, s) {
        final p = s.data?.data();
        if (p == null) return const SizedBox();
        return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          future: Api.db.collection('apps').doc(p['appId']).get(),
          builder: (_, a) {
            final app = a.data?.data();
            final pkg = app?['packageName'] as String? ?? '';
            final t = Theme.of(context).textTheme;
            final installed = _installedStatuses.contains(m['status']);
            final state = p['state'] as String;
            return Card(
              margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(app?['name'] ?? '…', style: t.titleMedium)),
                    _InstallChip(installed: installed),
                  ]),
                  Text(pkg, style: t.bodySmall),
                  const SizedBox(height: 10),
                  ..._body(context, state, p, installed, pkg),
                ]),
              ),
            );
          },
        );
      },
    );
  }

  List<Widget> _body(BuildContext context, String state, Map<String, dynamic> p, bool installed, String pkg) {
    final t = Theme.of(context).textTheme;
    final now = DateTime.now().millisecondsSinceEpoch;
    final leave = TextButton(onPressed: () => _leave(context, m['poolId']), child: const Text('Leave'));
    final installButtons = Wrap(spacing: 8, runSpacing: 4, children: [
      FilledButton.icon(onPressed: () => onStore(pkg), icon: const Icon(Icons.download), label: const Text('Download app')),
      OutlinedButton.icon(onPressed: onCheck, icon: const Icon(Icons.refresh), label: const Text('Check install')),
      leave,
    ]);

    switch (state) {
      case 'filling':
        return [
          Text('Waiting for ${18 - (p['testerCount'] as int)} more testers.', style: t.titleSmall),
          Text(installed
              ? 'Already installed. Testing starts once the pool is full and everyone has installed.'
              : 'When the pool is full you get 24 h to install the app. You can install it early.'),
          const SizedBox(height: 8),
          installed ? Wrap(children: [leave]) : installButtons,
        ];
      case 'installing':
        final deadline = p['installDeadline'] as int? ?? now;
        final total = p['installDeadline'] == null ? 1 : (deadline - (p['installStartedAt'] as int? ?? deadline - _dayMs));
        return [
          Text('Install period · ${_until(deadline - now)} left', style: t.titleSmall),
          const SizedBox(height: 6),
          LinearProgressIndicator(value: total <= 0 ? 1 : ((total - (deadline - now)) / total).clamp(0.0, 1.0)),
          const SizedBox(height: 6),
          Text('${p['installedCount'] ?? 0} of ${p['testerCount']} testers have installed.'),
          Text(installed
              ? 'Your install is confirmed. Day 1 starts when everyone has installed, at the latest in ${_until(deadline - now)}.'
              : 'Download and install the app. We check your phone and confirm the install automatically. '
                  'If it is not installed when the timer ends, you are removed from this test.'),
          const SizedBox(height: 8),
          installed ? Wrap(children: [leave]) : installButtons,
        ];
      case 'running':
      case 'at_risk':
        if (!installed) {
          return [
            Text('Install needed', style: t.titleSmall),
            const Text('Install the app to start your daily tests. We confirm the install automatically.'),
            const SizedBox(height: 8),
            installButtons,
          ];
        }
        final started = p['startedAt'] as int;
        final own = (m['installedAt'] as int?) ?? (m['joinedAt'] as int);
        final dayStart = own > started ? own : started; // same rule as the server
        final day = (now - dayStart) ~/ _dayMs + 1;
        final nextDay = dayStart + day * _dayMs;
        final doneToday = m['lastTestDay'] == day;
        final tested = (m['checkInCount'] ?? 0) as int;
        return [
          LinearProgressIndicator(value: day.clamp(1, 16) / 16),
          const SizedBox(height: 8),
          Text('Day ${day.clamp(1, 16)} of 16 · $tested ${tested == 1 ? 'day' : 'days'} tested', style: t.titleSmall),
          Text(doneToday
              ? 'Today\'s test is done. Day ${day + 1} starts in ${_until(nextDay - now)}.'
              : 'Today\'s test is due. Day ${day + 1} starts in ${_until(nextDay - now)}.'),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 4, children: [
            FilledButton.icon(
              onPressed: doneToday ? null : onTest,
              icon: Icon(doneToday ? Icons.check : Icons.play_arrow),
              label: Text(doneToday ? 'Tested today' : 'Test app (30 s)'),
            ),
            if (day >= 8 && m['feedback8'] != true)
              OutlinedButton(onPressed: () => _feedback(context, m['poolId'], 8), child: const Text('Day 8 feedback')),
            if (day >= 16 && m['feedback16'] != true)
              OutlinedButton(onPressed: () => _feedback(context, m['poolId'], 16), child: const Text('Day 16 feedback')),
            leave,
          ]),
        ];
      default:
        return [Text('Pool $state')];
    }
  }

  Future<void> _leave(BuildContext context, String poolId) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Leave this test?'),
        content: const Text('Leaving a running test lowers your reputation and earns no credit.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Stay')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Leave')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.leavePool(poolId);
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendly(e))));
    }
  }

  Future<void> _feedback(BuildContext context, String poolId, int day) async {
    final text = TextEditingController();
    int rating = 4;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(builder: (ctx, set) => AlertDialog(
        title: Text('Day $day feedback'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Slider(value: rating.toDouble(), min: 1, max: 5, divisions: 4, label: '$rating', onChanged: (v) => set(() => rating = v.round())),
          TextField(controller: text, maxLines: 4, decoration: const InputDecoration(hintText: 'What worked, what broke?')),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send'))],
      )),
    );
    if (ok != true) return;
    try {
      await Api.feedback(poolId, day, rating, text.text);
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendly(e))));
    }
  }
}

/// Install status as recorded in the backend.
class _InstallChip extends StatelessWidget {
  final bool installed;
  const _InstallChip({required this.installed});
  @override
  Widget build(BuildContext context) => Chip(
        visualDensity: VisualDensity.compact,
        avatar: Icon(installed ? Icons.verified : Icons.hourglass_empty, size: 16),
        label: Text(installed ? 'Installed' : 'Not installed'),
      );
}
