import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Announcement } from '../api/types';
import { colors } from '../styles/theme';
import { relativeTime } from '../utils/format';

interface NoticeCardProps {
  announcement: Announcement;
}

export function NoticeCard({ announcement }: NoticeCardProps) {
  const getCategoryTheme = () => {
    switch (announcement.category) {
      case 'EMERGENCY':
        return {
          bg: '#ffe4e6',
          text: '#9f1239',
          border: '#fecdd3',
          label: '🚨 Emergency',
        };
      case 'MAINTENANCE':
        return {
          bg: colors.amberSoft,
          text: colors.amberInk,
          border: colors.amberBorder,
          label: '🔧 Maintenance',
        };
      case 'EVENT':
        return {
          bg: '#dbeafe',
          text: '#1e40af',
          border: '#bfdbfe',
          label: '🎉 Event',
        };
      case 'GENERAL':
      default:
        return {
          bg: colors.fog,
          text: colors.textMuted,
          border: colors.border,
          label: '📢 Notice',
        };
    }
  };

  const theme = getCategoryTheme();
  const authorName =
    typeof announcement.author === 'string'
      ? announcement.author
      : announcement.author?.name || 'Society Management';

  return (
    <View
      style={[
        styles.card,
        announcement.pinned && styles.pinnedCard,
      ]}
    >
      {/* Pinned banner if pinned */}
      {announcement.pinned ? (
        <View style={styles.pinnedBanner}>
          <Text style={styles.pinnedText}>📌 Pinned Announcement</Text>
        </View>
      ) : null}

      <View style={styles.contentWrapper}>
        <View style={styles.headerRow}>
          <View
            style={[
              styles.categoryBadge,
              { backgroundColor: theme.bg, borderColor: theme.border },
            ]}
          >
            <Text style={[styles.categoryText, { color: theme.text }]}>
              {theme.label}
            </Text>
          </View>
          <Text style={styles.timeText}>{relativeTime(announcement.createdAt)}</Text>
        </View>

        <Text style={styles.title}>{announcement.title}</Text>
        <Text style={styles.body}>{announcement.content}</Text>

        <View style={styles.footerRow}>
          <Text style={styles.authorText}>Posted by {authorName}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paper,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    marginBottom: 14,
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
    overflow: 'hidden',
  },
  pinnedCard: {
    borderColor: colors.amber,
    backgroundColor: '#fffdf7',
  },
  pinnedBanner: {
    backgroundColor: colors.amberSoft,
    paddingVertical: 4,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.amberBorder,
  },
  pinnedText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.amberInk,
  },
  contentWrapper: {
    padding: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  timeText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '500',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
    fontFamily: 'Georgia',
    marginBottom: 6,
    lineHeight: 22,
  },
  body: {
    fontSize: 13,
    color: colors.charcoal,
    lineHeight: 19,
    marginBottom: 10,
  },
  footerRow: {
    borderTopWidth: 1,
    borderTopColor: colors.fog,
    paddingTop: 8,
    marginTop: 4,
  },
  authorText: {
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
