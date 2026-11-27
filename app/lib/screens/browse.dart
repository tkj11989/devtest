import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';

/// Home: filling pools with fill count; join flow shows the opt-in link only after joining.
class BrowseScreen extends StatelessWidget {
  const BrowseScreen({super.key});
  @override
  Widget build(BuildContext context) => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: Api.fillingPools(),
        builder: (_, s) {
          final pools = s.data?.docs ?? [];
          if (pools.isEmpty) return const Center(child: Text('No pools are filling right now.'));
          return ListView(children: [for (final p in pools) _PoolTile(p.data())]);
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
          return ListTile(
            title: Text(app?['name'] ?? '…'),
            subtitle: Text('${pool['testerCount']}/18 joined · ${app?['description'] ?? ''}', maxLines: 2),
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
  String? link;

  Future<void> join() async {
    setState(() => busy = true);
    try {
      link = await Api.joinPool(widget.pool['poolId']);
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
          const SizedBox(height: 12),
          const Text('Test instructions', style: TextStyle(fontWeight: FontWeight.bold)),
          Text(widget.app['testInstructions'] ?? ''),
          const SizedBox(height: 12),
          const Text('Your email is added to a platform-wide Google Group; the developer never sees it.'),
          const SizedBox(height: 16),
          if (link == null)
            FilledButton(onPressed: busy ? null : join, child: const Text('Join this test (1 of your 2 slots)'))
          else ...[
            const Text('Joined. Next: opt in, install from Play Store, then tap "I installed" in My tests.'),
            const SizedBox(height: 8),
            FilledButton(onPressed: () => launchUrl(Uri.parse(link!), mode: LaunchMode.externalApplication), child: const Text('Open opt-in link')),
          ],
          TextButton(onPressed: () => Api.report('app', widget.app['appId'], 'Reported from pool detail'), child: const Text('Report this app')),
        ])),
      );
}
