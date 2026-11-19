import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../api.dart';

/// Balance, history and the rewarded-ad button. Ads never appear inside check-in or feedback flows.
class CreditsScreen extends StatelessWidget {
  const CreditsScreen({super.key});
  @override
  Widget build(BuildContext context) => Column(children: [
        StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          stream: Api.me(),
          builder: (_, s) => ListTile(
            title: Text('${s.data?.data()?['credits'] ?? 0} credits', style: Theme.of(context).textTheme.headlineSmall),
            subtitle: Text('Reputation ${s.data?.data()?['reputation'] ?? 0}'),
            trailing: FilledButton(
              // TODO: show a RewardedAd from google_mobile_ads and call this only in onUserEarnedReward.
              onPressed: () => Api.rewardedAd(),
              child: const Text('Watch ad'),
            ),
          ),
        ),
        const Divider(),
        Expanded(
          child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
            stream: Api.ledger(),
            builder: (_, s) => ListView(children: [
              for (final d in s.data?.docs ?? [])
                ListTile(title: Text(d['reason']), trailing: Text('${d['delta'] > 0 ? '+' : ''}${d['delta']}')),
            ]),
          ),
        ),
      ]);
}
