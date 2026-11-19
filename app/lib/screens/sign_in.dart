import 'package:flutter/material.dart';
import '../api.dart';

class SignInScreen extends StatelessWidget {
  const SignInScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Mutual Testing', style: Theme.of(context).textTheme.headlineLarge, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            const Text('Get 18 real testers for your 16-day closed test by testing other developers\' apps.', textAlign: TextAlign.center),
            const SizedBox(height: 8),
            const Text('Sign in with the Google account you use on the Play Store: it is the email the platform group adds for you.',
                textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton.icon(onPressed: Api.signIn, icon: const Icon(Icons.login), label: const Text('Sign in with Google')),
          ]),
        ),
      );
}
