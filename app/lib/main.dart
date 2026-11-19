import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'screens/home_shell.dart';
import 'screens/sign_in.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(); // run `flutterfire configure` to generate platform config
  await MobileAds.instance.initialize();
  runApp(const MutualTestingApp());
}

class MutualTestingApp extends StatelessWidget {
  const MutualTestingApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Mutual Testing',
        theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
        home: StreamBuilder<User?>(
          stream: FirebaseAuth.instance.authStateChanges(),
          builder: (_, s) => s.data == null ? const SignInScreen() : const HomeShell(),
        ),
      );
}
