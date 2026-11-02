import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, ApiError } from '../api/client';
import type { AccessPoint, FlatLink, PassWithCredentials, VisitorCategory } from '../api/types';
import { colors } from '../styles/theme';
import { calculateWindowDates, type WindowPreset } from '../utils/format';

interface QuickRegisterModalProps {
  visible: boolean;
  onClose: () => void;
  flats: FlatLink[];
  selectedFlat: FlatLink | null;
  accessPoints: AccessPoint[];
  onPassCreated: (pass: PassWithCredentials, meta: { vehicle?: string; purpose?: string }) => void;
  initialCategory?: VisitorCategory;
}

export function QuickRegisterModal({
  visible,
  onClose,
  flats,
  selectedFlat,
  accessPoints,
  onPassCreated,
  initialCategory = 'RELATIVE',
}: QuickRegisterModalProps) {
  const [category, setCategory] = useState<VisitorCategory>(initialCategory);
  const [flatId, setFlatId] = useState<string>(selectedFlat?.id ?? flats[0]?.id ?? '');
  const [visitorName, setVisitorName] = useState('');
  const [phone, setPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('MULTIPLE_DAYS_3');
  const [customHours, setCustomHours] = useState('12');
  const [maxUses, setMaxUses] = useState(10);
  const [selectedGateIds, setSelectedGateIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync default flat and gates
  useEffect(() => {
    if (selectedFlat) {
      setFlatId(selectedFlat.id);
    } else if (flats.length > 0 && !flatId) {
      setFlatId(flats[0].id);
    }
  }, [selectedFlat, flats]);

  useEffect(() => {
    if (accessPoints.length > 0 && selectedGateIds.length === 0) {
      setSelectedGateIds(accessPoints.map((a) => a.id));
    }
  }, [accessPoints]);

  // Adjust defaults when category changes
  const applyCategoryDefaults = (cat: VisitorCategory) => {
    setCategory(cat);
    setError(null);
    if (cat === 'RELATIVE') {
      setWindowPreset('MULTIPLE_DAYS_3');
      setMaxUses(10);
      setPurpose('Family Visit');
      if (visitorName === 'Delivery Partner' || visitorName === 'Cab Driver' || visitorName === 'Technician') {
        setVisitorName('');
      }
    } else if (cat === 'FRIEND') {
      setWindowPreset('TODAY');
      setMaxUses(2);
      setPurpose('Social Visit');
    } else if (cat === 'DELIVERY') {
      setWindowPreset('TODAY');
      setMaxUses(1);
      if (!visitorName) setVisitorName('Delivery Partner');
      setPurpose('Package Delivery');
    } else if (cat === 'CAB') {
      setWindowPreset('TODAY');
      setMaxUses(1);
      if (!visitorName) setVisitorName('Cab Driver');
      setPurpose('Cab Pickup / Drop');
    } else if (cat === 'MAINTENANCE') {
      setWindowPreset('TODAY');
      setMaxUses(2);
      if (!visitorName) setVisitorName('Technician');
      setPurpose('Maintenance Service');
    }
  };

  const toggleGate = (id: string) => {
    setSelectedGateIds((prev) =>
      prev.includes(id) ? prev.filter((gid) => gid !== id) : [...prev, id],
    );
  };

  const handleSubmit = async () => {
    setError(null);
    const trimmedName = visitorName.trim();
    if (!trimmedName) {
      setError('Please enter visitor / relative name.');
      return;
    }
    if (!flatId) {
      setError('Please select a destination flat.');
      return;
    }
    if (selectedGateIds.length === 0) {
      setError('Please select at least one entry gate.');
      return;
    }

    const trimmedVehicle = vehicle.trim().toUpperCase();
    const trimmedPurpose = purpose.trim();
    const finalName = trimmedVehicle ? `${trimmedName} [${trimmedVehicle}]`.slice(0, 120) : trimmedName;

    const { validFrom, validUntil } = calculateWindowDates(
      windowPreset,
      parseInt(customHours, 10) || 12,
    );

    setLoading(true);
    try {
      if (category === 'RELATIVE') {
        try {
          const registered = await api.registerRelative(flatId, {
            name: trimmedName,
            relation: trimmedPurpose || 'Family / Relative',
            phone: phone.trim() || undefined,
            defaultVehicle: trimmedVehicle || undefined,
          });
          if (registered.initialPass) {
            onPassCreated(
              {
                pass: {
                  id: registered.initialPass.id,
                  societyId: registered.relative.societyId,
                  status: registered.initialPass.status,
                  effectiveStatus: registered.initialPass.status,
                  category: 'RELATIVE',
                  visitor: {
                    id: registered.relative.visitorId,
                    name: registered.relative.name,
                    phone: registered.relative.phone ?? null,
                  },
                  flat: {
                    id: flatId,
                    flatNumber: selectedFlat?.flatNumber ?? '',
                    building: selectedFlat?.building.name ?? '',
                  },
                  host: {
                    id: '',
                    name: 'Resident',
                  },
                  validFrom: registered.initialPass.validFrom,
                  validUntil: registered.initialPass.validUntil,
                  maxUses: registered.initialPass.maxUses,
                  usedCount: 0,
                  accessPoints: accessPoints,
                  requiresApproval: false,
                  createdAt: new Date().toISOString(),
                },
                credentials: registered.initialPass.credentials,
              },
              { vehicle: trimmedVehicle, purpose: trimmedPurpose || 'Family / Relative' },
            );
            onClose();
            return;
          }
        } catch (relativeErr: any) {
          // Fall back to standard createPass ONLY if relative is already registered in directory
          const isDuplicate =
            (relativeErr instanceof ApiError &&
              (relativeErr.code === 'DUPLICATE_RELATIVE' || relativeErr.status === 409)) ||
            relativeErr?.code === 'DUPLICATE_RELATIVE';
          if (!isDuplicate) {
            throw relativeErr;
          }
        }
      }

      const created = await api.createPass({
        flatId,
        visitor: {
          name: finalName,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        },
        category,
        validFrom,
        validUntil,
        maxUses,
        accessPointIds: selectedGateIds,
      });

      onPassCreated(created, { vehicle: trimmedVehicle, purpose: trimmedPurpose });
      onClose();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to register visitor pass. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>FAST RESIDENT PASS</Text>
              <Text style={styles.modalTitle}>Register Relative / Visitor</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Category Presets */}
            <Text style={styles.sectionTitle}>CATEGORY</Text>
            <View style={styles.presetChipRow}>
              {(
                [
                  { key: 'RELATIVE', label: 'Family / Relative' },
                  { key: 'FRIEND', label: 'Guest' },
                  { key: 'DELIVERY', label: 'Delivery' },
                  { key: 'CAB', label: 'Cab' },
                  { key: 'MAINTENANCE', label: 'Service' },
                ] as const
              ).map((chip) => (
                <TouchableOpacity
                  key={chip.key}
                  style={[
                    styles.presetChip,
                    category === chip.key && styles.presetChipActive,
                  ]}
                  onPress={() => applyCategoryDefaults(chip.key)}
                >
                  <Text
                    style={[
                      styles.presetChipText,
                      category === chip.key && styles.presetChipTextActive,
                    ]}
                  >
                    {chip.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Visitor Details */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>
                {category === 'RELATIVE' ? "RELATIVE'S FULL NAME *" : 'VISITOR FULL NAME *'}
              </Text>
              <TextInput
                style={styles.input}
                placeholder={category === 'RELATIVE' ? 'e.g. Ramesh Patel / Priya Sharma' : 'e.g. John Doe'}
                placeholderTextColor={colors.textMutedLight}
                value={visitorName}
                onChangeText={setVisitorName}
              />
            </View>

            <View style={styles.rowFields}>
              <View style={[styles.fieldGroup, { flex: 1.2 }]}>
                <Text style={styles.fieldLabel}>PHONE NUMBER</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 98765 43210"
                  placeholderTextColor={colors.textMutedLight}
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
                />
              </View>
              <View style={[styles.fieldGroup, { flex: 1 }]}>
                <Text style={styles.fieldLabel}>VEHICLE NO. (OPTIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="MH 02 CZ 4411"
                  placeholderTextColor={colors.textMutedLight}
                  autoCapitalize="characters"
                  value={vehicle}
                  onChangeText={setVehicle}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>PURPOSE OF VISIT</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Weekend family stay / Lunch"
                placeholderTextColor={colors.textMutedLight}
                value={purpose}
                onChangeText={setPurpose}
              />
            </View>

            {/* Validity Window Presets */}
            <Text style={styles.sectionTitle}>VALIDITY WINDOW</Text>
            <View style={styles.windowChipGrid}>
              {[
                { key: 'TODAY', label: 'Today (4h)' },
                { key: 'REST_OF_DAY', label: 'Rest of Today' },
                { key: 'WEEKEND', label: 'This Weekend' },
                { key: 'MULTIPLE_DAYS_3', label: 'Multiple Days (3d)' },
                { key: 'MULTIPLE_DAYS_7', label: 'Multiple Days (7d)' },
                { key: 'CUSTOM', label: 'Custom' },
              ].map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={[
                    styles.windowChip,
                    windowPreset === item.key && styles.windowChipActive,
                  ]}
                  onPress={() => setWindowPreset(item.key as WindowPreset)}
                >
                  <Text
                    style={[
                      styles.windowChipText,
                      windowPreset === item.key && styles.windowChipTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Custom Hours Input if CUSTOM selected */}
            {windowPreset === 'CUSTOM' ? (
              <View style={[styles.fieldGroup, { marginTop: 10 }]}>
                <Text style={styles.fieldLabel}>CUSTOM DURATION (HOURS, 1 - 168)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 12, 24, 48"
                  placeholderTextColor={colors.textMutedLight}
                  keyboardType="number-pad"
                  value={customHours}
                  onChangeText={setCustomHours}
                />
              </View>
            ) : null}

            {/* Max Uses Counter */}
            <View style={styles.stepperRow}>
              <View>
                <Text style={styles.fieldLabel}>MAX GATE ENTRIES</Text>
                <Text style={styles.stepperSubtext}>Number of times pass can open barriers</Text>
              </View>
              <View style={styles.stepperControls}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setMaxUses((prev) => Math.max(1, prev - 1))}
                >
                  <Text style={styles.stepperBtnText}>−</Text>
                </TouchableOpacity>
                <Text style={styles.stepperValue}>{maxUses}</Text>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setMaxUses((prev) => Math.min(10, prev + 1))}
                >
                  <Text style={styles.stepperBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Gates */}
            {accessPoints.length > 0 ? (
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>PERMITTED GATE READERS</Text>
                <View style={styles.gatesRow}>
                  {accessPoints.map((gate) => {
                    const isSelected = selectedGateIds.includes(gate.id);
                    return (
                      <TouchableOpacity
                        key={gate.id}
                        style={[styles.gateChip, isSelected && styles.gateChipSelected]}
                        onPress={() => toggleGate(gate.id)}
                      >
                        <Text style={[styles.gateChipText, isSelected && styles.gateChipTextSelected]}>
                          {isSelected ? '✓ ' : '+ '}
                          {gate.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={{ height: 20 }} />
          </ScrollView>

          {/* Footer Submit */}
          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={[styles.submitButton, loading && styles.submitButtonDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <ActivityIndicator color={colors.primaryText} />
              ) : (
                <Text style={styles.submitButtonText}>
                  {category === 'RELATIVE' ? '✨ Generate Relative Pass & PIN' : '✨ Generate Visitor Pass & PIN'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(13, 42, 36, 0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalEyebrow: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: colors.amber,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    fontSize: 16,
    color: colors.charcoal,
    fontWeight: '600',
  },
  modalBody: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  errorBox: {
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    padding: 10,
    borderRadius: 8,
    marginBottom: 14,
  },
  errorText: {
    color: '#9f1239',
    fontSize: 13,
    fontWeight: '500',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
    letterSpacing: 1,
    marginBottom: 8,
  },
  presetChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  presetChipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  presetChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink,
  },
  presetChipTextActive: {
    color: colors.primaryText,
  },
  fieldGroup: {
    marginBottom: 14,
  },
  rowFields: {
    flexDirection: 'row',
    gap: 12,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.charcoal,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink,
  },
  windowChipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  windowChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  windowChipActive: {
    backgroundColor: colors.amberSoft,
    borderColor: colors.amber,
  },
  windowChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.charcoal,
  },
  windowChipTextActive: {
    color: colors.amberInk,
    fontWeight: '700',
  },
  stepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  stepperSubtext: {
    fontSize: 11,
    color: colors.textMuted,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.fog,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperBtnText: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
  },
  stepperValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    minWidth: 20,
    textAlign: 'center',
  },
  gatesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  gateChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.fog,
    borderWidth: 1,
    borderColor: colors.border,
  },
  gateChipSelected: {
    backgroundColor: colors.activeBg,
    borderColor: colors.activeBorder,
  },
  gateChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  gateChipTextSelected: {
    color: colors.activeText,
    fontWeight: '700',
  },
  modalFooter: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  submitButton: {
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: colors.primaryText,
    fontSize: 15,
    fontWeight: '700',
  },
});
