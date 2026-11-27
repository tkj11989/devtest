import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../api.dart';
import '../main.dart' show useEmulator;

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final email = TextEditingController(text: 'tester1@test.local');
  String? error;

  /// Local emulator only: email/password account (password "password"), created on first use.
  Future<void> testSignIn() async {
    setState(() => error = null);
    final auth = FirebaseAuth.instance;
    final e = email.text.trim();
    try {
      try {
        await auth.signInWithEmailAndPassword(email: e, password: 'password');
      } on FirebaseAuthException {
        await auth.createUserWithEmailAndPassword(email: e, password: 'password');
      }
      await Api.call('ensureUser');
    } catch (err) {
      setState(() => error = err.toString());
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(24), children: [
            const SizedBox(height: 48),
            Text('Mutual Testing', style: Theme.of(context).textTheme.headlineLarge, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            const Text('Get 18 real testers for your 16-day closed test by testing other developers\' apps.',
                textAlign: TextAlign.center),
            const SizedBox(height: 24),
            if (useEmulator) ...[
              const Text('Local test mode', style: TextStyle(fontWeight: FontWeight.bold)),
              const Text('Uses the Firebase emulators on this PC. Demo developers: dev1@test.local, dev2@test.local, '
                  'dev3@test.local. Any other email creates a new tester. Password is always "password".'),
              const SizedBox(height: 8),
              TextField(controller: email, decoration: const InputDecoration(labelText: 'Email')),
              const SizedBox(height: 8),
              FilledButton(onPressed: testSignIn, child: const Text('Sign in with test account')),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: Colors.red))),
            ] else ...[
              const Text('Sign in with the Google account you use on the Play Store: it is the email the platform group adds for you.',
                  textAlign: TextAlign.center),
              const SizedBox(height: 16),
              FilledButton.icon(onPressed: Api.signIn, icon: const Icon(Icons.login), label: const Text('Sign in with Google')),
            ],
          ]),
        ),
      );
}
