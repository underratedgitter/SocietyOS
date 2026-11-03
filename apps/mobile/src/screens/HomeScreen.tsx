import { useCallback, useEffect, useRef, useState } from 'react';
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
import { mobileStorage } from '../api/storage';
import type { AccessPoint, PassView, PassWithCredentials } from '../api/types';
import { PassBadge } from '../components/PassBadge';
import { PassCard } from '../components/PassCard';
import { QuickRegisterModal } from '../components/QuickRegisterModal';
import { useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';
import { categoryLabel, formatDateTime, formatWindow, relativeTime } from '../utils/format';

const CURRENT_STATUSES = new Set(['ACTIVE', 'PENDING_APPROVAL', 'SCHEDULED']);

interface HomeScreenProps {
  onRegisterPress?: () => void;
  registerModalOpen: boolean;
  setRegisterModalOpen: (open: boolean) => void;
}

export function HomeScreen({
  registerModalOpen,
  setRegisterModalOpen,
}: HomeScreenProps) {
  const { session, selectedFlat, selectedSociety, isOffline } = useAuth();
  const [passes, setPasses] = useState<PassView[]>([]);
  // Read via ref so the loader isn't recreated (and re-fired) whenever the list length changes.
  const passesCountRef = useRef(0);
  passesCountRef.current = passes.length;
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'current' | 'history'>('current');
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [issuedCredentials, setIssuedCredentials] = useState<
    Record<string, { pin: string; qrToken: string }>
  >({});

  // Active pass details modal
  const [selectedPassModal, setSelectedPassModal] = useState<{
    passWithCredentials:
      | PassWithCredentials
      | { pass: PassView; credentials?: { pin?: string; qrToken?: string } | null };
    meta?: { vehicle?: string; purpose?: string } | null;
  } | null>(null);

  const societyId = selectedSociety?.id ?? '';
  const flatId = selectedFlat?.id ?? '';

  // Load cached passes and credentials on mount for instantaneous offline access
  useEffect(() => {
    void (async () => {
      const [cachedPasses, cachedCreds] = await Promise.all([
        mobileStorage.loadCachedPasses<PassView[]>(),
        mobileStorage.loadCachedCredentials(),
      ]);
      if (cachedPasses && cachedPasses.length > 0) {
        setPasses(cachedPasses);
        setLoading(false);
      }
      if (cachedCreds) {
        setIssuedCredentials(cachedCreds);
      }
    })();
  }, []);

  const loadData = useCallback(async () => {
    if (!societyId) return;
    setError(null);
    try {
      const [passPage, gates] = await Promise.all([
        api.listPasses(societyId, 100),
        flatId ? api.getAccessPoints(flatId).catch(() => []) : Promise.resolve([]),
      ]);
      setPasses(passPage.items);
      setAccessPoints(gates);
      void mobileStorage.saveCachedPasses(passPage.items);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        // If passes already exist from local cache, keep showing them gracefully
        if (passesCountRef.current === 0) {
          const cached = await mobileStorage.loadCachedPasses<PassView[]>();
          if (cached && cached.length > 0) {
            setPasses(cached);
          } else {
            setError('Operating offline. No cached passes found.');
          }
        }
      } else {
        const msg = err instanceof ApiError ? err.message : 'Could not refresh pass data.';
        setError(msg);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [societyId, flatId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadData();
  };

  const handleApprove = async (pass: PassView) => {
    setActionBusyId(pass.id);
    try {
      const approved = await api.approvePass(pass.id, 'APPROVED');
      if (approved.credentials) {
        // Shown once: the same PIN and QR the visitor receives, cached like a newly created pass.
        const { credentials, ...approvedPass } = approved;
        const nextCreds = { ...issuedCredentials, [approvedPass.id]: credentials };
        setIssuedCredentials(nextCreds);
        void mobileStorage.saveCachedCredentials(nextCreds);
        setSelectedPassModal({ passWithCredentials: { pass: approvedPass, credentials } });
      } else {
        Alert.alert('Pass Approved', `${pass.visitor.name} has been approved for gate entry.`);
      }
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to approve pass.';
      Alert.alert('Approval Error', msg);
    } finally {
      setActionBusyId(null);
    }
  };

  const handleRevoke = (pass: PassView) => {
    Alert.alert(
      'Revoke Visitor Pass',
      `Are you sure you want to revoke gate access for ${pass.visitor.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke Pass',
          style: 'destructive',
          onPress: async () => {
            setActionBusyId(pass.id);
            try {
              await api.revokePass(pass.id, 'Revoked by resident via mobile');
              Alert.alert('Pass Revoked', 'The pass and gate credentials are now invalidated.');
              await loadData();
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Failed to revoke pass.';
              Alert.alert('Revocation Error', msg);
            } finally {
              setActionBusyId(null);
            }
          },
        },
      ],
    );
  };

  // View pass credential modal
  const handleViewPass = (pass: PassView) => {
    const creds = issuedCredentials[pass.id] ?? null;
    setSelectedPassModal({
      passWithCredentials: {
        pass,
        credentials: creds,
      },
    });
  };

  const currentPasses = passes.filter((p) => CURRENT_STATUSES.has(p.effectiveStatus));
  const historyPasses = passes.filter((p) => !CURRENT_STATUSES.has(p.effectiveStatus));
  const awaitingApproval = passes.filter((p) => p.effectiveStatus === 'PENDING_APPROVAL');
  const activeAtGate = currentPasses.filter((p) => p.effectiveStatus === 'ACTIVE');

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
            <Text style={styles.offlineText}>⚡ Operating in offline mode. Viewing cached visitor passes.</Text>
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
            <Text style={styles.statLabel}>PASSES IN PLAY</Text>
            <Text style={styles.statValue}>{currentPasses.length}</Text>
            <Text style={styles.statSub}>active & scheduled</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>AT GATE NOW</Text>
            <Text style={[styles.statValue, { color: colors.activeText }]}>
              {activeAtGate.length}
            </Text>
            <Text style={styles.statSub}>ready to enter</Text>
          </View>

          <View style={styles.statBox}>
            <Text style={styles.statLabel}>WAITING APPROVAL</Text>
            <Text style={[styles.statValue, { color: colors.amber }]}>
              {awaitingApproval.length}
            </Text>
            <Text style={styles.statSub}>delivery & cab</Text>
          </View>
        </View>

        {/* Action Hero: Quick Family / Relative Button */}
        <View style={styles.quickHero}>
          <View style={styles.quickHeroContent}>
            <Text style={styles.quickHeroTitle}>Family Visiting Soon?</Text>
            <Text style={styles.quickHeroSub}>
              Register visiting relatives in 1 tap and share instant gate PINs over WhatsApp.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.quickHeroBtn}
            onPress={() => setRegisterModalOpen(true)}
            activeOpacity={0.85}
          >
            <Text style={styles.quickHeroBtnText}>+ Register Relative</Text>
          </TouchableOpacity>
        </View>

        {/* Awaiting Approval Section */}
        {awaitingApproval.length > 0 ? (
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionTitle}>⚠️ Waiting for Your Approval</Text>
                <Text style={styles.sectionSub}>Approve only if you are expecting this visitor.</Text>
              </View>
            </View>

            {awaitingApproval.map((pass) => (
              <View key={pass.id} style={styles.awaitingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.passVisitorName}>{pass.visitor.name}</Text>
                  <Text style={styles.passMeta}>
                    {categoryLabel(pass.category)} ·{' '}
                    {formatWindow(pass.validFrom, pass.validUntil, selectedSociety?.timezone)}
                  </Text>
                </View>

                <View style={styles.awaitingActions}>
                  <TouchableOpacity
                    style={[styles.approveBtn, actionBusyId === pass.id && styles.btnDisabled]}
                    onPress={() => void handleApprove(pass)}
                    disabled={actionBusyId === pass.id}
                  >
                    <Text style={styles.approveBtnText}>✓ Approve</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.rejectBtn, actionBusyId === pass.id && styles.btnDisabled]}
                    onPress={() => handleRevoke(pass)}
                    disabled={actionBusyId === pass.id}
                  >
                    <Text style={styles.rejectBtnText}>✕ Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* Tab Switcher: Current vs History */}
        <View style={styles.filterTabs}>
          <TouchableOpacity
            style={[styles.filterTab, activeSubTab === 'current' && styles.filterTabActive]}
            onPress={() => setActiveSubTab('current')}
          >
            <Text
              style={[
                styles.filterTabText,
                activeSubTab === 'current' && styles.filterTabTextActive,
              ]}
            >
              Current Passes ({currentPasses.length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterTab, activeSubTab === 'history' && styles.filterTabActive]}
            onPress={() => setActiveSubTab('history')}
          >
            <Text
              style={[
                styles.filterTabText,
                activeSubTab === 'history' && styles.filterTabTextActive,
              ]}
            >
              Pass History ({historyPasses.length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Pass List */}
        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.ink} />
            <Text style={styles.loadingText}>Fetching active society passes…</Text>
          </View>
        ) : activeSubTab === 'current' ? (
          currentPasses.length > 0 ? (
            currentPasses.map((pass) => (
              <TouchableOpacity
                key={pass.id}
                style={styles.passCardRow}
                onPress={() => handleViewPass(pass)}
                activeOpacity={0.8}
              >
                <View style={styles.passMainInfo}>
                  <View style={styles.passTitleRow}>
                    <Text style={styles.passVisitorName}>{pass.visitor.name}</Text>
                    <PassBadge status={pass.effectiveStatus} />
                  </View>

                  <Text style={styles.passMeta}>
                    {categoryLabel(pass.category)}
                    {pass.visitor.phone ? ` · ${pass.visitor.phone}` : ''} ·{' '}
                    {pass.accessPoints.map((g) => g.name).join(', ') || 'All gates'}
                  </Text>

                  <Text style={styles.passWindowText}>
                    ⏱️ {formatWindow(pass.validFrom, pass.validUntil, selectedSociety?.timezone)}
                  </Text>

                  <View style={styles.passFooterRow}>
                    <Text style={styles.passUsesText}>
                      {pass.usedCount} of {pass.maxUses} entries used
                    </Text>

                    <TouchableOpacity
                      style={styles.revokeSmallBtn}
                      onPress={(e) => {
                        e.stopPropagation();
                        handleRevoke(pass);
                      }}
                      disabled={actionBusyId === pass.id}
                    >
                      <Text style={styles.revokeSmallBtnText}>Revoke</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>No Active Visitor Passes</Text>
              <Text style={styles.emptySub}>
                Invite your family, friends, or service visitors to generate instant gate PINs.
              </Text>
              <TouchableOpacity
                style={styles.emptyActionBtn}
                onPress={() => setRegisterModalOpen(true)}
              >
                <Text style={styles.emptyActionBtnText}>+ Register Relative / Visitor</Text>
              </TouchableOpacity>
            </View>
          )
        ) : historyPasses.length > 0 ? (
          historyPasses.map((pass) => (
            <View key={pass.id} style={styles.historyRow}>
              <View style={styles.historyTimeCol}>
                <Text style={styles.historyTimeText}>{relativeTime(pass.validUntil)}</Text>
              </View>
              <View style={styles.historyMainCol}>
                <View style={styles.passTitleRow}>
                  <Text style={styles.historyVisitorName}>{pass.visitor.name}</Text>
                  <PassBadge status={pass.effectiveStatus} />
                </View>
                <Text style={styles.historyMeta}>
                  {categoryLabel(pass.category)} ·{' '}
                  {formatDateTime(pass.validFrom, selectedSociety?.timezone)} · {pass.usedCount}/
                  {pass.maxUses} entries
                </Text>
              </View>
            </View>
          ))
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No Pass History</Text>
            <Text style={styles.emptySub}>
              Past, expired, and revoked passes will be archived here.
            </Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Floating Action Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setRegisterModalOpen(true)}
        activeOpacity={0.85}
      >
        <Text style={styles.fabIcon}>+</Text>
        <Text style={styles.fabText}>New Pass</Text>
      </TouchableOpacity>

      {/* Quick Register Modal */}
      {selectedFlat ? (
        <QuickRegisterModal
          visible={registerModalOpen}
          onClose={() => setRegisterModalOpen(false)}
          flats={session?.flats ?? []}
          selectedFlat={selectedFlat}
          accessPoints={accessPoints}
          onPassCreated={(newPassWithCreds, meta) => {
            const nextCreds = {
              ...issuedCredentials,
              [newPassWithCreds.pass.id]: newPassWithCreds.credentials,
            };
            setIssuedCredentials(nextCreds);
            void mobileStorage.saveCachedCredentials(nextCreds);
            setSelectedPassModal({
              passWithCredentials: newPassWithCreds,
              meta,
            });
            void loadData();
          }}
        />
      ) : null}

      {/* Perforated Pass Card View Modal */}
      {selectedPassModal ? (
        <Modal
          visible={!!selectedPassModal}
          animationType="fade"
          transparent
          onRequestClose={() => setSelectedPassModal(null)}
        >
          <View style={styles.passModalOverlay}>
            <ScrollView contentContainerStyle={styles.passModalContent}>
              <PassCard
                passData={selectedPassModal.passWithCredentials}
                timezone={selectedSociety?.timezone}
                meta={selectedPassModal.meta}
                onClose={() => setSelectedPassModal(null)}
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
  quickHero: {
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
  quickHeroContent: {
    flex: 1,
  },
  quickHeroTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginBottom: 4,
  },
  quickHeroSub: {
    fontSize: 12,
    color: colors.charcoal,
    lineHeight: 16,
  },
  quickHeroBtn: {
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
  quickHeroBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.amber,
    padding: 14,
    marginBottom: 16,
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.amberInk,
  },
  sectionSub: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  awaitingRow: {
    borderTopWidth: 1,
    borderTopColor: colors.fog,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  awaitingActions: {
    flexDirection: 'row',
    gap: 8,
  },
  approveBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  approveBtnText: {
    color: colors.primaryText,
    fontSize: 12,
    fontWeight: '700',
  },
  rejectBtn: {
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  rejectBtnText: {
    color: '#9f1239',
    fontSize: 12,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  filterTabs: {
    flexDirection: 'row',
    backgroundColor: colors.fog,
    borderRadius: 10,
    padding: 4,
    marginBottom: 14,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  filterTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  filterTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  filterTabTextActive: {
    color: colors.ink,
    fontWeight: '700',
  },
  passCardRow: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  passMainInfo: {
    gap: 6,
  },
  passTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  passVisitorName: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    flex: 1,
    paddingRight: 8,
  },
  passMeta: {
    fontSize: 12,
    color: colors.charcoal,
    fontWeight: '500',
  },
  passWindowText: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '500',
  },
  passFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.fog,
    paddingTop: 8,
    marginTop: 4,
  },
  passUsesText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '600',
  },
  revokeSmallBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  revokeSmallBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9f1239',
  },
  historyRow: {
    flexDirection: 'row',
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 12,
  },
  historyTimeCol: {
    width: 60,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  historyTimeText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '600',
  },
  historyMainCol: {
    flex: 1,
    gap: 4,
  },
  historyVisitorName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  historyMeta: {
    fontSize: 11,
    color: colors.textMuted,
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    backgroundColor: colors.ink,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
    gap: 6,
  },
  fabIcon: {
    color: colors.primaryText,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 22,
  },
  fabText: {
    color: colors.primaryText,
    fontWeight: '700',
    fontSize: 14,
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
