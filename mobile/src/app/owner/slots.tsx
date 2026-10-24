import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Calendar } from '../../components/Calendar';
import { Sheet } from '../../components/Sheet';
import { Button, Chip, ErrorBanner } from '../../components/ui';
import { api, type SlotStatus } from '../../lib/api';
import { confirm } from '../../lib/confirm';
import { addDays, errorMessage, rupees, shortDate, slotRange, toISODate, hourLabel } from '../../lib/format';
import { colors, radius, shadow } from '../../lib/theme';
import { useOwnerGrounds } from '../../lib/useOwnerGrounds';

type OwnerSlot = { startHour: number; label: string; price: number; status: SlotStatus; enabled: boolean; bookedBy: string | null };
type Form = { mode: 'add' } | { mode: 'edit'; slot: OwnerSlot };

export default function ManageSlots() {
  const params = useLocalSearchParams<{ groundId?: string }>();
  const { grounds, error: groundsError } = useOwnerGrounds();
  const today = useMemo(() => toISODate(new Date()), []);
  const [groundId, setGroundId] = useState<string | null>(params.groundId ?? null);
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<OwnerSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [menu, setMenu] = useState<OwnerSlot | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [hour, setHour] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!groundId && grounds?.length) setGroundId(grounds[0].id);
  }, [grounds, groundId]);

  const load = useCallback(async () => {
    if (!groundId) return;
    try {
      const res = await api<{ slots: OwnerSlot[] }>(`/owner/grounds/${groundId}/slots?date=${date}`);
      setSlots(res.slots);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [groundId, date]);

  useEffect(() => {
    setSlots(null);
    load();
  }, [load]);

  async function toggle(slot: OwnerSlot, enabled: boolean) {
    setSlots((s) => s?.map((x) => (x.startHour === slot.startHour ? { ...x, enabled } : x)) ?? null);
    try {
      await api(`/owner/grounds/${groundId}/slots/${slot.startHour}/availability`, { method: 'PUT', body: { date, enabled } });
    } catch (e) {
      setError(errorMessage(e));
      load();
    }
  }

  function openForm(f: Form) {
    setMenu(null);
    setForm(f);
    setFormError(null);
    setHour(f.mode === 'edit' ? f.slot.startHour : null);
    setPrice(f.mode === 'edit' ? String(f.slot.price) : String(slots?.[0]?.price ?? ''));
  }

  async function saveForm() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      if (form.mode === 'add') {
        await api(`/owner/grounds/${groundId}/slots`, { body: { startHour: hour, price: Number(price) } });
      } else {
        await api(`/owner/grounds/${groundId}/slots/${form.slot.startHour}`, { method: 'PATCH', body: { price: Number(price) } });
      }
      setForm(null);
      load();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  function remove(slot: OwnerSlot) {
    setMenu(null);
    confirm('Delete slot?', `${slot.label} will be removed for all dates.`, 'Delete', async () => {
      try {
        await api(`/owner/grounds/${groundId}/slots/${slot.startHour}`, { method: 'DELETE' });
        load();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  }

  const taken = new Set(slots?.map((s) => s.startHour));
  const freeHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => !taken.has(h));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {(grounds?.length ?? 0) > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {grounds!.map((g) => (
              <Chip key={g.id} label={g.name} active={g.id === groundId} onPress={() => setGroundId(g.id)} />
            ))}
          </ScrollView>
        )}

        <View>
          <Text style={styles.label}>Date</Text>
          <Pressable style={styles.dateField} onPress={() => setCalendar(true)} accessibilityLabel="Change date">
            <Text style={{ color: colors.text, fontSize: 15 }}>{shortDate(date)}</Text>
            <Ionicons name="calendar-outline" size={20} color={colors.text} />
          </Pressable>
        </View>

        <View style={styles.headerRow}>
          <Text style={styles.section}>Time Slots</Text>
          <Pressable style={styles.add} onPress={() => openForm({ mode: 'add' })}>
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700' }}>Add Slot</Text>
          </Pressable>
        </View>

        <ErrorBanner message={error ?? groundsError} />
        {!slots && !error && <ActivityIndicator color={colors.primary} />}
        <View style={styles.list}>
          {slots?.map((s, i) => {
            const locked = s.status === 'BOOKED' || s.status === 'PAST';
            return (
              <View key={s.startHour} style={[styles.slot, i < slots.length - 1 && styles.border, s.status === 'PAST' && { opacity: 0.45 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.slotLabel, !s.enabled && { color: colors.muted }]}>{slotRange(s.startHour)}</Text>
                  <Text style={styles.slotMeta}>
                    {rupees(s.price)}
                    {s.status === 'BOOKED' ? ` · Booked by ${s.bookedBy}` : s.status === 'PAST' ? ' · Past' : !s.enabled ? ' · Off' : ''}
                  </Text>
                </View>
                <Switch
                  value={s.enabled}
                  disabled={locked}
                  onValueChange={(v) => toggle(s, v)}
                  trackColor={{ true: colors.primary, false: '#CBD3CF' }}
                  thumbColor="#fff"
                  accessibilityLabel={`${s.label} available`}
                />
                <Pressable onPress={() => setMenu(s)} hitSlop={10} style={{ paddingLeft: 10 }} accessibilityLabel={`More options for ${s.label}`}>
                  <Ionicons name="ellipsis-vertical" size={18} color={colors.muted} />
                </Pressable>
              </View>
            );
          })}
        </View>
        <Text style={styles.hint}>Switching a slot off hides it from players for {shortDate(date)} only. Existing bookings are not affected.</Text>
      </ScrollView>

      <Sheet visible={calendar} onClose={() => setCalendar(false)} title="Select Date">
        <Calendar
          value={date}
          minDate={today}
          maxDate={addDays(today, 30)}
          onChange={(d) => {
            setDate(d);
            setCalendar(false);
          }}
        />
      </Sheet>

      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.label ?? ''}>
        <Pressable style={styles.menuItem} onPress={() => menu && openForm({ mode: 'edit', slot: menu })}>
          <Ionicons name="pricetag-outline" size={20} color={colors.text} />
          <Text style={styles.menuText}>Edit price</Text>
        </Pressable>
        <Pressable style={styles.menuItem} onPress={() => menu && remove(menu)}>
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
          <Text style={[styles.menuText, { color: colors.danger }]}>Delete slot</Text>
        </Pressable>
      </Sheet>

      <Sheet visible={!!form} onClose={() => setForm(null)} title={form?.mode === 'edit' ? `Edit ${form.slot.label}` : 'Add Slot'}>
        {form?.mode === 'add' && (
          <>
            <Text style={styles.label}>Start time (1 hour slot)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {freeHours.map((h) => (
                <Chip key={h} label={hourLabel(h)} active={hour === h} onPress={() => setHour(h)} />
              ))}
            </ScrollView>
          </>
        )}
        <Text style={styles.label}>Price per hour (₹)</Text>
        <TextInput
          style={styles.input}
          value={price}
          onChangeText={(t) => setPrice(t.replace(/\D/g, ''))}
          keyboardType="number-pad"
          placeholder="e.g. 1500"
          placeholderTextColor={colors.muted}
        />
        <ErrorBanner message={formError} />
        <Button title="Save" onPress={saveForm} loading={saving} disabled={!price || (form?.mode === 'add' && hour === null)} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontWeight: '600', color: colors.muted, fontSize: 13, marginBottom: 6 },
  dateField: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 14 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  section: { fontSize: 16, fontWeight: '800', color: colors.text },
  add: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  list: { backgroundColor: '#fff', borderRadius: radius, paddingHorizontal: 14, ...shadow },
  slot: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  border: { borderBottomWidth: 1, borderBottomColor: colors.border },
  slotLabel: { fontWeight: '700', color: colors.text },
  slotMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  menuText: { fontSize: 15, color: colors.text, fontWeight: '600' },
  input: { borderWidth: 1.5, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 16, color: colors.text },
});
