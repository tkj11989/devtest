import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../api.dart';

class MyAppsScreen extends StatelessWidget {
  const MyAppsScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: FloatingActionButton.extended(
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AppForm())),
            label: const Text('Add app'), icon: const Icon(Icons.add)),
        body: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
          stream: Api.myApps(),
          builder: (_, s) => ListView(children: [
            for (final a in s.data?.docs ?? [])
              ListTile(
                title: Text(a['name']),
                subtitle: Text(a['packageName']),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => AppDashboard(a.id))),
              ),
          ]),
        ),
      );
}

class AppForm extends StatefulWidget {
  const AppForm({super.key});
  @override
  State<AppForm> createState() => _AppFormState();
}

class _AppFormState extends State<AppForm> {
  final c = {for (final k in ['name', 'packageName', 'description', 'testInstructions']) k: TextEditingController()};
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Add app')),
        body: SafeArea(top: false, child: ListView(padding: const EdgeInsets.all(16), children: [
          for (final e in c.entries) Padding(padding: const EdgeInsets.only(bottom: 12), child: TextField(controller: e.value, decoration: InputDecoration(labelText: e.key), maxLines: e.key.contains('Instructions') ? 4 : 1)),
          FilledButton(
            onPressed: () async {
              await Api.saveApp(
                info: {for (final k in ['name', 'packageName', 'description', 'testInstructions']) k: c[k]!.text.trim()},
              );
              if (context.mounted) Navigator.pop(context);
            },
            child: const Text('Save'),
          ),
        ])),
      );
}

/// Setup checklist + pool dashboard for one app.
class AppDashboard extends StatelessWidget {
  final String appId;
  const AppDashboard(this.appId, {super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('App setup & pools')),
        body: SafeArea(top: false, child: StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          stream: Api.db.collection('apps').doc(appId).snapshots(),
          builder: (_, s) {
            final cl = Map<String, dynamic>.from(s.data?.data()?['checklist'] ?? {});
            const labels = {
              'groupAdded': 'Added the platform group email to my closed track\'s testers',
              'buildReleased': 'Released a build to the closed track',
            };
            return ListView(padding: const EdgeInsets.all(8), children: [
              for (final e in labels.entries)
                CheckboxListTile(value: cl[e.key] == true, title: Text(e.value), onChanged: (v) => Api.setChecklist(appId, {e.key: v ?? false})),
              Padding(
                padding: const EdgeInsets.all(8),
                child: FilledButton(
                    onPressed: cl.values.every((v) => v == true)
                        ? () async {
                            try { await Api.createPool(appId); } catch (e) {
                              if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(friendly(e))));
                            }
                          }
                        : null,
                    child: const Text('Open a pool (1 credit)')),
              ),
              StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                stream: Api.db.collection('pools').where('appId', isEqualTo: appId).snapshots(),
                builder: (_, ps) => Column(children: [
                  for (final p in ps.data?.docs ?? [])
                    ListTile(
                      title: Text(p['state'] == 'installing'
                          ? 'Install period · ${p['installedCount'] ?? 0}/${p['testerCount']} installed'
                          : '${p['state']} · ${p['activeCount']}/${p['testerCount']} active · ${p['installedCount'] ?? 0} installed'),
                      subtitle: Text(switch (p['state']) {
                        'filling' => 'Waiting for 18 testers, then a 24 h install period starts.',
                        'installing' => 'Testers are installing. Day 1 starts when all have installed or the timer ends.',
                        'at_risk' => 'Fewer than 14 active: replacements are being pulled.',
                        _ => 'Needs 12 active at day 16',
                      }),
                      trailing: p['state'] == 'filling' ? TextButton(onPressed: () => Api.cancelPool(p.id), child: const Text('Cancel')) : null,
                    ),
                ]),
              ),
            ]);
          },
        )),
      );
}
