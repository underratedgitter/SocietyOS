import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, ApiError } from '../api/client';
import { mobileStorage } from '../api/storage';
import type { Announcement } from '../api/types';
import { NoticeCard } from '../components/NoticeCard';
import { useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';

type NoticeCategoryFilter = 'ALL' | 'EMERGENCY' | 'MAINTENANCE' | 'EVENT' | 'GENERAL';

export function NoticesScreen() {
  const { session, selectedSociety } = useAuth();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  // Read via ref so the loader isn't recreated (and re-fired) whenever the list length changes.
  const announcementsCountRef = useRef(0);
  announcementsCountRef.current = announcements.length;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<NoticeCategoryFilter>('ALL');

  const societyId = selectedSociety?.id ?? '';
  const userId = session?.user?.id ?? '';
  const cacheScope = useMemo(() => ({ userId, societyId }), [userId, societyId]);
  const scopeId = `${userId}|${societyId}`;
  const scopeIdRef = useRef(scopeId);
  scopeIdRef.current = scopeId;
  const cacheLoadTokenRef = useRef(0);

  // Reset transient state on scope change.
  useEffect(() => {
    setAnnouncements([]);
    setError(null);
    setLoading(true);
  }, [scopeId]);

  // Load cached notices for active scope.
  useEffect(() => {
    const thisScopeId = scopeId;
    let active = true;
    const token = ++cacheLoadTokenRef.current;
    void (async () => {
      const cached = await mobileStorage.loadCachedNotices<Announcement[]>(cacheScope);
      if (!active || token !== cacheLoadTokenRef.current || scopeIdRef.current !== thisScopeId) return;
      if (cached && cached.length > 0) {
        setAnnouncements(cached);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [scopeId]);

  const loadNotices = useCallback(async () => {
    if (!societyId) return;
    const thisScopeId = scopeId;
    setError(null);
    try {
      const items = await api.listAnnouncements(societyId);
      if (scopeIdRef.current !== thisScopeId) return;
      setAnnouncements(items);
      void mobileStorage.saveCachedNotices(items, cacheScope);
    } catch (err) {
      if (scopeIdRef.current !== thisScopeId) return;
      if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        if (announcementsCountRef.current === 0) {
          const cached = await mobileStorage.loadCachedNotices<Announcement[]>(cacheScope);
          if (scopeIdRef.current !== thisScopeId) return;
          if (cached && cached.length > 0) {
            setAnnouncements(cached);
          } else {
            setError('Operating offline. No cached notices.');
          }
        }
      } else {
        const msg = err instanceof ApiError ? err.message : 'Could not fetch notices.';
        setError(msg);
      }
    } finally {
      if (scopeIdRef.current === thisScopeId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [societyId, scopeId, cacheScope]);

  useEffect(() => {
    void loadNotices();
  }, [loadNotices]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadNotices();
  };

  const filteredAnnouncements = announcements.filter((item) => {
    if (activeFilter === 'ALL') return true;
    return item.category === activeFilter;
  });

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
        {/* Screen Header */}
        <View style={styles.headerBox}>
          <Text style={styles.eyebrow}>COMMUNITY BOARD</Text>
          <Text style={styles.title}>Society Notices & Circulars</Text>
          <Text style={styles.subtitle}>
            Official announcements, maintenance schedules, and safety advisories for {selectedSociety?.name || 'your society'}.
          </Text>
        </View>

        {/* Filter Chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
          contentContainerStyle={styles.filterContainer}
        >
          {(
            [
              { key: 'ALL', label: 'All Notices' },
              { key: 'EMERGENCY', label: '🚨 Emergency' },
              { key: 'MAINTENANCE', label: '🔧 Maintenance' },
              { key: 'EVENT', label: '🎉 Events' },
              { key: 'GENERAL', label: '📢 General' },
            ] as const
          ).map((chip) => (
            <TouchableOpacity
              key={chip.key}
              style={[
                styles.filterChip,
                activeFilter === chip.key && styles.filterChipActive,
              ]}
              onPress={() => setActiveFilter(chip.key)}
            >
              <Text
                style={[
                  styles.filterChipText,
                  activeFilter === chip.key && styles.filterChipTextActive,
                ]}
              >
                {chip.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Error Notice */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity onPress={() => void loadNotices()} style={styles.retryBtn}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Notices Content */}
        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.ink} />
            <Text style={styles.loadingText}>Fetching circulars and notices…</Text>
          </View>
        ) : filteredAnnouncements.length > 0 ? (
          filteredAnnouncements.map((item) => (
            <NoticeCard key={item.id} announcement={item} />
          ))
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No Circulars in this Category</Text>
            <Text style={styles.emptySub}>
              Society administrators have not published notices under this filter.
            </Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
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
  headerBox: {
    marginBottom: 16,
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.amber,
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
  },
  filterScroll: {
    marginBottom: 16,
  },
  filterContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  filterChipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.charcoal,
  },
  filterChipTextActive: {
    color: colors.primaryText,
    fontWeight: '700',
  },
  errorBox: {
    backgroundColor: '#ffe4e6',
    borderWidth: 1,
    borderColor: '#fecdd3',
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorText: {
    color: '#9f1239',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  retryBtn: {
    backgroundColor: '#9f1239',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginLeft: 8,
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  loadingBox: {
    alignItems: 'center',
    paddingVertical: 40,
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
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    marginTop: 20,
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
  },
});
