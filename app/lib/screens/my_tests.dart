import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../api.dart';

class MyTestsScreen extends StatelessWidget {
  const MyTestsScreen({super.key});
  @override
  Widget build(BuildContext context) => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: Api.myMemberships(),
        builder: (_, s) {
          final active = (s.data?.docs ?? []).map((d) => d.data()).where((m) => ['joined', 'installed', 'active'].contains(m['status'])).toList();
          if (active.isEmpty) return const Center(child: Text('Join a pool from Browse to start testing.'));
          return ListView(children: [for (final m in active) _TestCard(m)]);
        },
      );
}

class _TestCard extends StatelessWidget {
  final Map<String, dynamic> m;
  const _TestCard(this.m);

  Future<void> run(BuildContext c, Future<void> Function() f) async {
    try {
      await f();
    } catch (e) {
      if (c.mounted) ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(friendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final poolId = m['poolId'] as String;
    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: Api.db.collection('pools').doc(poolId).snapshots(),
      builder: (_, s) {
        final p = s.data?.data();
        if (p == null) return const SizedBox();
        final started = p['startedAt'] as int?;
        final day = started == null ? null : ((DateTime.now().millisecondsSinceEpoch - started) ~/ 86400000) + 1;
        return Card(
          margin: const EdgeInsets.all(12),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Pool ${p['state']} · ${day == null ? "waiting for ${18 - (p['testerCount'] as int)} more testers" : "day $day of 16"}',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text('Check-ins: ${m['checkInCount']} · Status: ${m['status']}'),
              Wrap(spacing: 8, children: [
                if (m['status'] == 'joined') FilledButton(onPressed: () => run(context, () => Api.confirmInstalled(poolId)), child: const Text('I installed')),
                if (day != null) FilledButton(onPressed: () => run(context, () => Api.checkIn(poolId)), child: const Text('Check in today')),
                if (day != null && day >= 8 && m['feedback8'] != true)
                  OutlinedButton(onPressed: () => _feedback(context, poolId, 8), child: const Text('Day 8 feedback')),
                if (day != null && day >= 16 && m['feedback16'] != true)
                  OutlinedButton(onPressed: () => _feedback(context, poolId, 16), child: const Text('Day 16 feedback')),
                TextButton(onPressed: () => run(context, () => Api.leavePool(poolId)), child: const Text('Leave (reputation penalty once running)')),
              ]),
            ]),
          ),
        );
      },
    );
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
    if (ok == true && context.mounted) await run(context, () => Api.feedback(poolId, day, rating, text.text));
  }
}
