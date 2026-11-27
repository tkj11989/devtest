import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../api.dart';

/// Home: packages with a free tester slot. No opt-in link: once a pool has its 18 testers, everyone gets an
/// install period and the app detects the install by itself.
class BrowseScreen extends StatelessWidget {
  const BrowseScreen({super.key});
  @override
  Widget build(BuildContext context) => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: Api.fillingPools(),
        builder: (_, s) {
          final pools = (s.data?.docs ?? []).map((d) => d.data()).where((p) => (p['testerCount'] as int) < 18).toList();
          if (pools.isEmpty) return const Center(child: Text('No packages need testers right now.'));
          return ListView(children: [for (final p in pools) _PoolTile(p)]);
        },
      );
}

class _PoolTile extends StatelessWidget {
  final Map<String, dynamic> pool;
  const _PoolTile(this.pool);
  @override
  Widget build(BuildContext context) => FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        future: Api.db.collection('apps').doc(pool['appId']).get(),
        builder: (_, s) {
          final app = s.data?.data();
          final installing = pool['state'] == 'installing';
          return ListTile(
            title: Text(app?['name'] ?? '…'),
            subtitle: Text('${pool['testerCount']}/18 joined${installing ? ' · install period running' : ''} · '
                '${app?['description'] ?? ''}', maxLines: 2),
            trailing: const Icon(Icons.chevron_right),
            onTap: app == null ? null : () => Navigator.push(context, MaterialPageRoute(builder: (_) => PoolDetail(pool, app))),
          );
        },
      );
}

class PoolDetail extends StatefulWidget {
  final Map<String, dynamic> pool, app;
  const PoolDetail(this.pool, this.app, {super.key});
  @override
  State<PoolDetail> createState() => _PoolDetailState();
}

class _PoolDetailState extends State<PoolDetail> {
  bool busy = false;
  Map? joined; // {packageName, installBufferHours}

  Future<void> join() async {
    setState(() => busy = true);
    try {
      joined = await Api.joinPool(widget.pool['poolId']);
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendly(e))));
    }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.app['name'] ?? 'Pool')),
        body: SafeArea(top: false, child: ListView(padding: const EdgeInsets.all(16), children: [
          Text(widget.app['description'] ?? ''),
          const SizedBox(height: 4),
          Text(widget.app['packageName'] ?? '', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          const Text('Test instructions', style: TextStyle(fontWeight: FontWeight.bold)),
          Text(widget.app['testInstructions'] ?? ''),
          const SizedBox(height: 12),
          const Text('How it works', style: TextStyle(fontWeight: FontWeight.bold)),
          const Text('1. Join now.\n'
              '2. When 18 testers have joined, you get an install period (24 h) to download the app.\n'
              '3. This app checks your phone and confirms the install automatically.\n'
              '4. Then test the app for at least 30 seconds every day for 16 days.'),
          const SizedBox(height: 16),
          if (joined == null)
            FilledButton(onPressed: busy ? null : join, child: const Text('Join this test (uses 1 of your packages)'))
          else
            Card(
              child: ListTile(
                leading: const Icon(Icons.check_circle_outline),
                title: const Text('Joined'),
                subtitle: Text('Install ${joined!['packageName']} when the install period starts '
                    '(you will have ${joined!['installBufferHours']} h). Track it in My tests.'),
              ),
            ),
          TextButton(onPressed: () => Api.report('app', widget.app['appId'], 'Reported from pool detail'), child: const Text('Report this app')),
        ])),
      );
}
