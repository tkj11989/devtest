import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../api.dart';
import '../app_launcher.dart';

const _dayMs = 86400000;
const _activeStatuses = ['joined', 'installed', 'active'];

/// The tester's packages, each with its own 24-hour day counter and a daily 30-second test.
class MyTestsScreen extends StatefulWidget {
  const MyTestsScreen({super.key});
  @override
  State<MyTestsScreen> createState() => _MyTestsScreenState();
}

class _MyTestsScreenState extends State<MyTestsScreen> with WidgetsBindingObserver {
  Map? session; // {sessionId, poolId, packageName, minSeconds}
  Timer? tick;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    tick = Timer.periodic(const Duration(seconds: 30), (_) => setState(() {})); // refresh countdowns
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

  /// Step 1: get a server-stamped session, then open the app under test.
  Future<void> startTest(String poolId) async {
    try {
      final s = await Api.startTest(poolId);
      final pkg = s['packageName'] as String?;
      if (pkg == null || !await AppLauncher.isInstalled(pkg)) {
        snack('Install the app from the Play Store first (opt-in link in Browse), then test it.');
        return;
      }
      session = {...s, 'poolId': poolId};
      await AppLauncher.launch(pkg);
    } catch (e) {
      snack(friendly(e));
    }
  }

  /// Step 2: back in our app, ask the server whether 30 seconds have passed.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && session != null) finishTest();
  }

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
            return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
              _LimitHeader(used: active.length, user: me.data?.data()),
              if (active.isEmpty)
                const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Join a package from Browse to start testing.'))),
              for (final m in active) _TestCard(m, onTest: () => startTest(m['poolId'])),
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
            subtitle: const Text('Test each app for at least 30 seconds once every day (24 hours).'),
          );
        },
      );
}

class _TestCard extends StatelessWidget {
  final Map<String, dynamic> m;
  final VoidCallback onTest;
  const _TestCard(this.m, {required this.onTest});

  static String _until(int ms) {
    final d = Duration(milliseconds: ms < 0 ? 0 : ms);
    return '${d.inHours}h ${(d.inMinutes % 60).toString().padLeft(2, '0')}m';
  }

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
            final started = p['startedAt'] as int?;
            final now = DateTime.now().millisecondsSinceEpoch;
            // Same rule as the server: the tester's day 1 starts at the pool start, or at their own join if later.
            final dayStart = started == null ? null : (m['joinedAt'] as int) > started ? m['joinedAt'] as int : started;
            final day = dayStart == null ? null : (now - dayStart) ~/ _dayMs + 1;
            final nextDay = dayStart == null ? null : dayStart + day! * _dayMs;
            final doneToday = day != null && m['lastTestDay'] == day;
            final t = Theme.of(context).textTheme;
            return Card(
              margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(app?['name'] ?? '…', style: t.titleMedium),
                  Text(app?['packageName'] ?? '', style: t.bodySmall),
                  const SizedBox(height: 10),
                  if (day == null)
                    Text('Waiting for ${18 - (p['testerCount'] as int)} more testers. Day 1 starts when the pool is full.')
                  else ...[
                    LinearProgressIndicator(value: (day.clamp(1, 16)) / 16),
                    const SizedBox(height: 8),
                    Text('Day ${day.clamp(1, 16)} of 16 · ${m['checkInCount'] ?? 0} '
                        '${(m['checkInCount'] ?? 0) == 1 ? 'day' : 'days'} tested', style: t.titleSmall),
                    Text(doneToday
                        ? 'Today\'s test is done. Day ${day + 1} starts in ${_until(nextDay! - now)}.'
                        : 'Today\'s test is due. Day ${day + 1} starts in ${_until(nextDay! - now)}.'),
                  ],
                  const SizedBox(height: 10),
                  Wrap(spacing: 8, runSpacing: 4, children: [
                    if (day != null)
                      FilledButton.icon(
                        onPressed: doneToday ? null : onTest,
                        icon: Icon(doneToday ? Icons.check : Icons.play_arrow),
                        label: Text(doneToday ? 'Tested today' : 'Test app (30 s)'),
                      ),
                    if (day != null && day >= 8 && m['feedback8'] != true)
                      OutlinedButton(onPressed: () => _feedback(context, poolId, 8), child: const Text('Day 8 feedback')),
                    if (day != null && day >= 16 && m['feedback16'] != true)
                      OutlinedButton(onPressed: () => _feedback(context, poolId, 16), child: const Text('Day 16 feedback')),
                    TextButton(onPressed: () => _leave(context, poolId), child: const Text('Leave')),
                  ]),
                ]),
              ),
            );
          },
        );
      },
    );
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
