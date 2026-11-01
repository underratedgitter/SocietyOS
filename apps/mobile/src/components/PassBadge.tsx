import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../styles/theme';
import type { PassStatus } from '../api/types';

interface PassBadgeProps {
  status: PassStatus;
}

export function PassBadge({ status }: PassBadgeProps) {
  const getBadgeStyle = () => {
    switch (status) {
      case 'ACTIVE':
        return {
          bg: colors.activeBg,
          text: colors.activeText,
          border: colors.activeBorder,
          label: 'Active',
        };
      case 'PENDING_APPROVAL':
        return {
          bg: colors.pendingBg,
          text: colors.pendingText,
          border: colors.pendingBorder,
          label: 'Pending Approval',
        };
      case 'REVOKED':
        return {
          bg: colors.revokedBg,
          text: colors.revokedText,
          border: colors.revokedBorder,
          label: 'Revoked',
        };
      case 'EXPIRED':
      case 'EXHAUSTED':
        return {
          bg: colors.expiredBg,
          text: colors.expiredText,
          border: colors.expiredBorder,
          label: status === 'EXHAUSTED' ? 'Used' : 'Expired',
        };
      case 'SCHEDULED':
        return {
          bg: colors.scheduledBg,
          text: colors.scheduledText,
          border: colors.scheduledBorder,
          label: 'Scheduled',
        };
      default:
        return {
          bg: colors.expiredBg,
          text: colors.expiredText,
          border: colors.expiredBorder,
          label: status,
        };
    }
  };

  const style = getBadgeStyle();

  return (
    <View style={[styles.badge, { backgroundColor: style.bg, borderColor: style.border }]}>
      <View style={[styles.dot, { backgroundColor: style.text }]} />
      <Text style={[styles.text, { color: style.text }]}>{style.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 9999,
    borderWidth: 1,
    alignSelf: 'flex-start',
    gap: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
});
