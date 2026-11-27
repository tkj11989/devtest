import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'firebase_options.dart';
import 'screens/home_shell.dart';
import 'screens/sign_in.dart';

/// Debug builds use the local Firebase Emulator Suite unless built with --dart-define=USE_EMULATOR=false.
/// 10.0.2.2 is the Android emulator's address for the host machine.
const useEmulator = kDebugMode && bool.fromEnvironment('USE_EMULATOR', defaultValue: true);
const emulatorHost = String.fromEnvironment('EMULATOR_HOST', defaultValue: '10.0.2.2');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  if (useEmulator) {
    await FirebaseAuth.instance.useAuthEmulator(emulatorHost, 9099);
    FirebaseFirestore.instance.useFirestoreEmulator(emulatorHost, 8080);
    FirebaseFunctions.instance.useFunctionsEmulator(emulatorHost, 5001);
  }
  await MobileAds.instance.initialize();
  runApp(const MutualTestingApp());
}

class MutualTestingApp extends StatelessWidget {
  const MutualTestingApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Mutual Testing',
        theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
        // Android 15+ forces edge-to-edge; keep every screen (and the bottom tab bar) above the
        // system navigation bar / gesture handle instead of drawing underneath it.
        builder: (context, child) => ColoredBox(
          color: Theme.of(context).colorScheme.surface,
          child: SafeArea(top: false, left: false, right: false, child: child!),
        ),
        home: StreamBuilder<User?>(
          stream: FirebaseAuth.instance.authStateChanges(),
          builder: (_, s) => s.data == null ? const SignInScreen() : const HomeShell(),
        ),
      );
}
