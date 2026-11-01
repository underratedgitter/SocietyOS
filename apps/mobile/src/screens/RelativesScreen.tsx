import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, ApiError } from '../api/client';
import type { AccessPoint, PassWithCredentials, RelativeMember } from '../api/types';
import { PassCard } from '../components/PassCard';
import { QuickRegisterModal } from '../components/QuickRegisterModal';
import { useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';
import { relativeTime } from '../utils/format';

export function RelativesScreen() {
  const { session, selectedFlat, selectedSociety, isOffline } = useAuth();
  const [relatives, setRelatives] = useState<RelativeMember[]>([]);
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Active pass details modal for sharing
  const [passModal, setPassModal] = useState<{
    passWithCredentials: PassWithCredentials;
    meta?: { vehicle?: string; purpose?: string } | null;
  } | null>(null);

  const flatId = selectedFlat?.id ?? '';

  const loadData = useCallback(async () => {
    if (!flatId) return;
    setError(null);
    try {
      const [relativesList, gates] = await Promise.all([
        api.listRelatives(flatId),
        api.getAccessPoints(flatId).catch(() => []),
      ]);
      setRelatives(relativesList);
      setAccessPoints(gates);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not refresh family directory.';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [flatId]);

  useEffect(() => {
    setLoading(true);
    void loadData();
  }, [loadData]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadData();
  };

  const handleIssueQuickPass = async (relative: RelativeMember) => {
    if (!flatId) return;
    setActionBusyId(relative.visitorId);
    try {
      const result = await api.issueQuickPass(flatId, relative.visitorId, {
        validHours: 72,
        maxUses: 10,
        vehicle: relative.defaultVehicle || undefined,
      });

      setPassModal({
        passWithCredentials: {
          pass: result.pass,
          credentials: result.credentials,
        },
        meta: {
          vehicle: relative.defaultVehicle || undefined,
          purpose: `Family Visit (${relative.relation})`,
        },
      });

      await loadData();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to issue fast pass.';
      Alert.alert('Fast Pass Error', msg);
    } finally {
      setActionBusyId(null);
    }
  };

  const handleDeleteRelative = (relative: RelativeMember) => {
    if (!flatId) return;
    Alert.alert(
      'Remove Family Member',
      `Are you sure you want to remove ${relative.name} from flat ${selectedFlat?.flatNumber}? Any active gate passes will be immediately invalidated.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setActionBusyId(relative.visitorId);
            try {
              await api.deleteRelative(flatId, relative.visitorId);
              Alert.alert('Relative Removed', `${relative.name} has been removed from the directory.`);
              await loadData();
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Failed to remove relative.';
              Alert.alert('Error', msg);
            } finally {
              setActionBusyId(null);
            }
          },
        },
      ],
    );
  };

  const activePassCount = relatives.filter((r) => r.activePassCount > 0).length;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ink}
            colors={[colors.amber]}
          />
        }
      >
        {/* Offline Banner */}
        {isOffline ? (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineText}>⚡ Operating in offline mode. Viewing cached family directory.</Text>
          </View>
        ) : null}

        {/* Error Alert */}
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Stats Rail */}
        <View style={styles.statsRail}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>REGISTERED FAMILY</Text>
            <Text style={styles.statValue}>{relatives.length}</Text>
            <Text style={styles.statSub}>saved in directory</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>ACTIVE PASSES</Text>
            <Text style={[styles.statValue, { color: colors.activeText }]}>{activePassCount}</Text>
            <Text style={styles.statSub}>valid at gates now</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>FLAT UNIT</Text>
            <Text style={styles.statValue}>{selectedFlat?.flatNumber ?? '—'}</Text>
            <Text style={styles.statSub}>{selectedFlat?.building.name ?? 'Building'}</Text>
          </View>
        </View>

        {/* Hero Banner */}
        <View style={styles.heroBox}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroTitle}>Family & Relatives Directory</Text>
            <Text style={styles.heroSub}>
              Save your family members once. Issue instant 72-hour gate PINs with 1 tap anytime they visit.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.heroBtn}
            onPress={() => setModalOpen(true)}
            activeOpacity={0.85}
          >
            <Text style={styles.heroBtnText}>+ Add Family</Text>
          </TouchableOpacity>
        </View>

        {/* Relatives List */}
        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.ink} />
            <Text style={styles.loadingText}>Loading family directory…</Text>
          </View>
        ) : relatives.length > 0 ? (
          <View style={styles.listContainer}>
            {relatives.map((relative) => {
              const isBusy = actionBusyId === relative.visitorId;
              const hasActivePass = relative.activePassCount > 0;

              return (
                <View key={relative.id || relative.visitorId} style={styles.relativeCard}>
                  <View style={styles.relativeTopRow}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.nameRow}>
                        <Text style={styles.relativeName}>{relative.name}</Text>
                        <View style={styles.relationBadge}>
                          <Text style={styles.relationBadgeText}>{relative.relation}</Text>
                        </View>
                      </View>

                      <View style={styles.metaRow}>
                        {relative.phone ? (
                          <Text style={styles.metaText}>📱 {relative.phone}</Text>
                        ) : null}
                        {relative.defaultVehicle ? (
                          <Text style={styles.metaText}>🚗 {relative.defaultVehicle}</Text>
                        ) : null}
                        <Text style={styles.metaText}>
                          ⏱️ Last visit: {relative.lastVisitAt ? relativeTime(relative.lastVisitAt) : 'Never'}
                        </Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.deleteBtn}
                      onPress={() => handleDeleteRelative(relative)}
                      disabled={isBusy}
                    >
                      <Text style={styles.deleteBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.cardActionsRow}>
                    <View style={styles.passStatusTag}>
                      <Text
                        style={[
                          styles.passStatusText,
                          hasActivePass ? styles.statusActive : styles.statusNone,
                        ]}
                      >
                        {hasActivePass ? '● Active Gate Pass' : '○ No Active Pass'}
                      </Text>
                    </View>

                    <TouchableOpacity
                      style={[styles.quickPassBtn, isBusy && styles.btnDisabled]}
                      onPress={() => void handleIssueQuickPass(relative)}
                      disabled={isBusy}
                      activeOpacity={0.85}
                    >
                      {isBusy ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={styles.quickPassBtnText}>⚡ Issue Fast Pass</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No Relatives Registered</Text>
            <Text style={styles.emptySub}>
              Register visiting parents, siblings, or family members to give them 1-tap fast gate passes with WhatsApp sharing.
            </Text>
            <TouchableOpacity style={styles.emptyActionBtn} onPress={() => setModalOpen(true)}>
              <Text style={styles.emptyActionBtnText}>+ Register Family Member</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Register Relative Modal */}
      {selectedFlat ? (
        <QuickRegisterModal
          visible={modalOpen}
          onClose={() => setModalOpen(false)}
          flats={session?.flats ?? []}
          selectedFlat={selectedFlat}
          accessPoints={accessPoints}
          initialCategory="RELATIVE"
          onPassCreated={(newPassWithCreds, meta) => {
            setPassModal({
              passWithCredentials: newPassWithCreds,
              meta,
            });
            void loadData();
          }}
        />
      ) : null}

      {/* Perforated Pass Card View Modal */}
      {passModal ? (
        <Modal
          visible={!!passModal}
          animationType="fade"
          transparent
          onRequestClose={() => setPassModal(null)}
        >
          <View style={styles.passModalOverlay}>
            <ScrollView contentContainerStyle={styles.passModalContent}>
              <PassCard
                passData={passModal.passWithCredentials}
                timezone={selectedSociety?.timezone}
                meta={passModal.meta}
                onClose={() => setPassModal(null)}
              />
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: 16,
  },
  offlineBanner: {
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: colors.amber,
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  offlineText: {
    color: colors.amberInk,
    fontSize: 12,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  errorText: {
    color: '#9f1239',
    fontSize: 12,
    fontWeight: '600',
  },
  statsRail: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  statBox: {
    flex: 1,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  statLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 4,
    textAlign: 'center',
  },
  statValue: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
    fontFamily: 'Courier',
    lineHeight: 26,
  },
  statSub: {
    fontSize: 9,
    color: colors.textMutedLight,
    marginTop: 2,
    textAlign: 'center',
  },
  heroBox: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    shadowColor: colors.amberInk,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  heroTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginBottom: 4,
  },
  heroSub: {
    fontSize: 12,
    color: colors.charcoal,
    lineHeight: 16,
  },
  heroBtn: {
    backgroundColor: colors.amber,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    shadowColor: colors.amberInk,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  heroBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  listContainer: {
    gap: 12,
  },
  relativeCard: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 14,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  relativeTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  relativeName: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
  },
  relationBadge: {
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: colors.amber,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  relationBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.amberInk,
  },
  metaRow: {
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    color: colors.charcoal,
    fontWeight: '500',
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    fontSize: 12,
    color: '#9f1239',
    fontWeight: '700',
  },
  cardActionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.fog,
    paddingTop: 10,
    marginTop: 10,
  },
  passStatusTag: {
    flex: 1,
  },
  passStatusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusActive: {
    color: colors.activeText,
  },
  statusNone: {
    color: colors.textMuted,
  },
  quickPassBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  quickPassBtnText: {
    color: colors.primaryText,
    fontSize: 12,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  loadingBox: {
    alignItems: 'center',
    paddingVertical: 36,
    gap: 10,
  },
  loadingText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  emptyBox: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginVertical: 20,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginBottom: 6,
  },
  emptySub: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  emptyActionBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  emptyActionBtnText: {
    color: colors.primaryText,
    fontSize: 13,
    fontWeight: '700',
  },
  passModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(13, 42, 36, 0.75)',
    justifyContent: 'center',
  },
  passModalContent: {
    padding: 20,
    justifyContent: 'center',
  },
});
