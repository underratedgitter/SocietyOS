'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  Check,
  Clock,
  KeyRound,
  Phone,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import { Badge, EmptyState, Notice, Toast, errorMessage } from '@/components/ui';
import { formatDateTime, relativeTime } from '@/lib/format';
import { fetchRelatives, removeRelative } from './api';
import { RegisterRelativeModal } from './register-relative-modal';
import { QuickPassModal } from './quick-pass-modal';
import type { QuickPassResult, RelativeMember } from './types';

export function RelativesManagementView({
  flatId,
  societyId,
}: {
  flatId: string;
  societyId: string;
}) {
  const [relatives, setRelatives] = useState<RelativeMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [registerModalOpen, setRegisterModalOpen] = useState(false);
  const [quickPassRelative, setQuickPassRelative] = useState<RelativeMember | null>(null);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);

  const loadData = useCallback(() => {
    if (!flatId) return;
    setLoading(true);
    setError('');
    fetchRelatives(flatId)
      .then((data) => {
        setRelatives(data);
      })
      .catch((caught) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [flatId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleRemove(relative: RelativeMember) {
    if (!window.confirm(`Remove ${relative.name} (${relative.relation}) from your family directory? Any active passes will be revoked.`)) {
      return;
    }

    try {
      await removeRelative(flatId, relative.visitorId);
      setToast({ message: `${relative.name} removed from relatives directory.` });
      loadData();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 className="panel-title" style={{ margin: 0, fontSize: 18 }}>
              Family & Relatives Directory
            </h2>
            <Badge tone="active">{relatives.length} registered</Badge>
          </div>
          <p className="tiny muted" style={{ marginTop: 4 }}>
            Pre-registered relatives can enter through vehicle gates or turnstiles with fast 1-click passes.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-small" onClick={loadData} disabled={loading}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => setRegisterModalOpen(true)}
          >
            <UserPlus size={14} /> Register Relative
          </button>
        </div>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {/* Relatives Grid */}
      {relatives.length === 0 && !loading ? (
        <EmptyState
          title="No relatives registered yet"
          copy="Register your parents, siblings, children, or extended family members. You will be able to generate 1-click gate passes for them anytime without typing in their information."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {relatives.map((rel) => {
            const hasActivePass = rel.activePassCount > 0;
            return (
              <div
                key={rel.id}
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 12,
                  boxShadow: '0 2px 6px rgba(0,0,0,0.02)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 15, color: 'var(--ink)' }}>{rel.name}</strong>
                        <span
                          className="badge"
                          style={{
                            background: 'var(--amber-soft)',
                            color: 'var(--amber-ink)',
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 6px',
                          }}
                        >
                          {rel.relation}
                        </span>
                      </div>
                      {rel.phone ? (
                        <div className="tiny muted" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <Phone size={11} /> {rel.phone}
                        </div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      className="btn-ghost btn-small"
                      onClick={() => handleRemove(rel)}
                      title="Remove relative"
                      style={{ padding: 4 }}
                    >
                      <Trash2 size={13} color="var(--text-muted)" />
                    </button>
                  </div>

                  {rel.defaultVehicle ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--charcoal)', background: 'var(--fog)', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
                      🚗 {rel.defaultVehicle}
                    </div>
                  ) : null}
                </div>

                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    {hasActivePass ? (
                      <span className="badge" style={{ background: '#ecfdf5', color: '#065f46', fontSize: 11, fontWeight: 700 }}>
                        ● Gate Pass Active
                      </span>
                    ) : (
                      <span className="tiny muted">
                        {rel.lastVisitAt ? `Last visited ${relativeTime(rel.lastVisitAt)}` : 'No recent visits'}
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="btn btn-small"
                    style={{
                      background: hasActivePass ? 'var(--fog)' : 'var(--primary)',
                      color: hasActivePass ? 'var(--ink)' : 'var(--paper)',
                      fontWeight: 600,
                    }}
                    onClick={() => setQuickPassRelative(rel)}
                  >
                    <Zap size={13} color={hasActivePass ? 'var(--amber)' : '#FFFFFF'} />
                    {hasActivePass ? 'View / Renew Pass' : 'Issue Fast Pass'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Register Modal */}
      {registerModalOpen ? (
        <RegisterRelativeModal
          flatId={flatId}
          onClose={() => setRegisterModalOpen(false)}
          onRegistered={(rel, pass) => {
            setToast({ message: `Registered ${rel.name} (${rel.relation}) with active entry pass!` });
            loadData();
          }}
        />
      ) : null}

      {/* Quick Pass Modal */}
      {quickPassRelative ? (
        <QuickPassModal
          flatId={flatId}
          relative={quickPassRelative}
          onClose={() => setQuickPassRelative(null)}
          onPassCreated={() => {
            setToast({ message: `Fast pass issued for ${quickPassRelative.name}` });
            loadData();
          }}
        />
      ) : null}

      {toast ? (
        <Toast
          message={toast.message}
          error={toast.error}
          onClose={() => setToast(null)}
        />
      ) : null}
    </div>
  );
}
