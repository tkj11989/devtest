import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, type IconName } from '../components/ui';
import { colors } from '../lib/theme';

const FAQ = [
  ['How do I cancel a booking?', 'Open the booking from My Bookings and tap "Cancel Booking". Cancellation is available until the slot starts.'],
  ['When will I get my refund?', 'Refunds for online payments reach your original payment method within 5-7 working days.'],
  ['How does Pay at Venue work?', 'Your slot is confirmed instantly. Pay the amount at the ground counter by cash or UPI before you play.'],
  ['I did not receive the confirmation SMS', 'Your booking is still confirmed. The ticket is always available under My Bookings and in Notifications.'],
];

const CONTACT: { icon: IconName; label: string; value: string; url: string }[] = [
  { icon: 'call-outline', label: 'Call us', value: '+91 98765 00000', url: 'tel:+919876500000' },
  { icon: 'mail-outline', label: 'Email', value: 'support@sportsspace.app', url: 'mailto:support@sportsspace.app' },
  { icon: 'logo-whatsapp', label: 'WhatsApp', value: 'Chat with us', url: 'https://wa.me/919876500000' },
];

export default function Help() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Card style={{ paddingVertical: 4 }}>
        {CONTACT.map((c, i) => (
          <Pressable key={c.label} style={[styles.row, i < CONTACT.length - 1 && styles.border]} onPress={() => Linking.openURL(c.url)}>
            <Ionicons name={c.icon} size={21} color={colors.primary} />
            <Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>{c.label}</Text>
            <Text style={{ color: colors.muted }}>{c.value}</Text>
          </Pressable>
        ))}
      </Card>
      <Text style={styles.section}>Frequently asked questions</Text>
      <Card style={{ paddingVertical: 4 }}>
        {FAQ.map(([q, a], i) => (
          <Pressable key={q} style={[styles.faq, i < FAQ.length - 1 && styles.border]} onPress={() => setOpen(open === i ? null : i)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, fontWeight: '600', color: colors.text }}>{q}</Text>
              <Ionicons name={open === i ? 'chevron-up' : 'chevron-down'} size={18} color={colors.muted} />
            </View>
            {open === i && <Text style={{ color: colors.muted, marginTop: 8, lineHeight: 20 }}>{a}</Text>}
          </Pressable>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 15 },
  border: { borderBottomWidth: 1, borderBottomColor: colors.border },
  section: { fontSize: 16, fontWeight: '800', color: colors.text },
  faq: { paddingVertical: 14 },
});
