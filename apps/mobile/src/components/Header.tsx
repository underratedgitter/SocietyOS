import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { colors } from '../styles/theme';

interface HeaderProps {
  onRegisterPress: () => void;
  activeTab: 'passes' | 'relatives' | 'notices';
  onTabChange: (tab: 'passes' | 'relatives' | 'notices') => void;
}

export function Header({ onRegisterPress, activeTab, onTabChange }: HeaderProps) {
  const { session, selectedFlat, logout, selectedSociety } = useAuth();

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to log out of SocietyOS?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void logout() },
    ]);
  };

  return (
    <View style={styles.headerContainer}>
      {/* Brand & Society Row */}
      <View style={styles.topRow}>
        <View style={styles.brandGroup}>
          <View style={styles.brandMark}>
            <View style={styles.brandMarkInner} />
          </View>
          <View>
            <Text style={styles.brandTitle}>SocietyOS</Text>
            <Text style={styles.brandSubtitle}>
              {selectedSociety?.name || 'Palm Grove'} · Residential
            </Text>
          </View>
        </View>

        <TouchableOpacity onPress={handleLogout} style={styles.userButton}>
          <Text style={styles.userButtonText}>
            {session?.user.name ? session.user.name.split(' ')[0] : 'Resident'} ⏻
          </Text>
        </TouchableOpacity>
      </View>

      {/* Flat & Quick Action Row */}
      <View style={styles.actionRow}>
        <View style={styles.flatTag}>
          <Text style={styles.flatTagLabel}>MY FLAT</Text>
          <Text style={styles.flatTagValue}>
            {selectedFlat
              ? `${selectedFlat.building.name} · ${selectedFlat.flatNumber}`
              : 'No flat linked'}
          </Text>
        </View>

        {/* Prominent "+ Register Relative / Family" quick button */}
        <TouchableOpacity
          style={styles.quickRegisterButton}
          onPress={onRegisterPress}
          activeOpacity={0.85}
        >
          <Text style={styles.quickRegisterButtonText}>+ Register Relative</Text>
        </TouchableOpacity>
      </View>

      {/* Navigation Tabs */}
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'passes' && styles.tabButtonActive]}
          onPress={() => onTabChange('passes')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'passes' && styles.tabButtonTextActive]}>
            🎟️ Passes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'relatives' && styles.tabButtonActive]}
          onPress={() => onTabChange('relatives')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'relatives' && styles.tabButtonTextActive]}>
            👨‍👩‍👧 Relatives
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'notices' && styles.tabButtonActive]}
          onPress={() => onTabChange('notices')}
        >
          <Text style={[styles.tabButtonText, activeTab === 'notices' && styles.tabButtonTextActive]}>
            📢 Notices
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  brandGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandMark: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkInner: {
    width: 12,
    height: 12,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  brandTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '500',
  },
  userButton: {
    backgroundColor: colors.fog,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  userButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  flatTag: {
    backgroundColor: colors.fog,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  flatTagLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.textMuted,
  },
  flatTagValue: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink,
  },
  quickRegisterButton: {
    flex: 1,
    backgroundColor: colors.amber,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.amberInk,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  quickRegisterButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  tabsRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.fog,
    paddingTop: 8,
    gap: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: colors.fog,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  tabButtonTextActive: {
    color: colors.ink,
    fontWeight: '700',
  },
});
