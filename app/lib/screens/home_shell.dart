import 'package:flutter/material.dart';
import 'browse.dart';
import 'credits.dart';
import 'my_apps.dart';
import 'my_tests.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int i = 0;
  static const pages = [BrowseScreen(), MyTestsScreen(), MyAppsScreen(), CreditsScreen()];
  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(child: pages[i]),
        bottomNavigationBar: NavigationBar(selectedIndex: i, onDestinationSelected: (v) => setState(() => i = v), destinations: const [
          NavigationDestination(icon: Icon(Icons.explore), label: 'Browse'),
          NavigationDestination(icon: Icon(Icons.checklist), label: 'My tests'),
          NavigationDestination(icon: Icon(Icons.apps), label: 'My apps'),
          NavigationDestination(icon: Icon(Icons.toll), label: 'Credits'),
        ]),
      );
}
