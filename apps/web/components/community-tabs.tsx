'use client';

import { useEffect, useState } from 'react';
import {
  Calendar,
  Clock,
  CreditCard,
  Pin,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  User,
  Wrench,
} from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { Badge, EmptyState, Modal, Notice } from './ui';
import type {
  Announcement,
  MaintenanceTicket,
  AmenityBooking,
  MaintenanceInvoice,
} from '@/lib/types';

// =========================================================================
// HELPERS & BADGES
// =========================================================================

export function AnnouncementCategoryBadge({ category }: { category: string }) {
  let tone = 'neutral';
  if (category === 'EMERGENCY') tone = 'denied';
  else if (category === 'MAINTENANCE') tone = 'active';
  else if (category === 'EVENT') tone = 'scheduled';
  return <Badge tone={tone}>{category}</Badge>;
}

export function TicketPriorityBadge({ priority }: { priority: string }) {
  let tone = 'neutral';
  if (priority === 'URGENT') tone = 'denied';
  else if (priority === 'HIGH') tone = 'active';
  else if (priority === 'MEDIUM') tone = 'scheduled';
  return <Badge tone={tone}>{priority} Priority</Badge>;
}

export function TicketStatusBadge({ status }: { status: string }) {
  let tone = 'neutral';
  if (status === 'RESOLVED' || status === 'CLOSED') tone = 'authorized';
  else if (status === 'IN_PROGRESS') tone = 'scheduled';
  else if (status === 'OPEN') tone = 'active';
  return <Badge tone={tone}>{status.replace('_', ' ')}</Badge>;
}

export function InvoiceStatusBadge({ status }: { status: string }) {
  let tone = 'neutral';
  if (status === 'PAID') tone = 'authorized';
  else if (status === 'OVERDUE') tone = 'denied';
  else if (status === 'PENDING') tone = 'scheduled';
  return <Badge tone={tone}>{status}</Badge>;
}

function getAuthorName(author?: { name?: string } | string | null): string {
  if (!author) return 'Management';
  return typeof author === 'object' ? (author.name || 'Management') : String(author);
}

function getFlatDisplay(flat?: { flatNumber?: string; building?: string | { name?: string } | null } | null): string {
  if (!flat) return '—';
  const b = typeof flat.building === 'object' && flat.building !== null ? flat.building.name : flat.building;
  return b ? `${b} · ${flat.flatNumber}` : (flat.flatNumber ?? '—');
}

function getBookedByName(bookedBy?: { name?: string } | string | null): string {
  if (!bookedBy) return 'Resident';
  return typeof bookedBy === 'object' ? (bookedBy.name || 'Resident') : String(bookedBy);
}

// =========================================================================
// 1. NOTICE BOARD / ANNOUNCEMENTS (RESIDENT)
// =========================================================================

export function ResidentNoticeBoard({ societyId }: { societyId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<Announcement[]>(`/api/v1/societies/${societyId}/announcements`);
      setAnnouncements(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load notice board');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Community Notice Board</h2>
          <span className="small muted">Official updates, emergency notices, and community circulars.</span>
        </div>
        <button className="btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {announcements.length === 0 && !loading ? (
        <EmptyState
          title="Notice board is quiet"
          copy="No announcements posted yet. Society administration notices will appear here."
        />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {announcements.map((ann) => (
            <article
              key={ann.id}
              className="panel"
              style={{
                borderLeft: ann.pinned ? '4px solid var(--amber)' : undefined,
                background: ann.category === 'EMERGENCY' ? 'var(--danger-soft)' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {ann.pinned ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--amber-ink)', fontWeight: 600, fontSize: 12 }}>
                      <Pin size={13} /> Pinned
                    </span>
                  ) : null}
                  <AnnouncementCategoryBadge category={ann.category} />
                </div>
                <span className="small muted">
                  {new Date(ann.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>{ann.title}</h3>
              <p style={{ color: 'var(--ink-2)', whiteSpace: 'pre-line', lineHeight: 1.6 }}>{ann.content}</p>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <User size={13} className="muted" />
                <span className="small muted">Posted by {getAuthorName(ann.author)}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// 2. MAINTENANCE HELPDESK (RESIDENT)
// =========================================================================

export function ResidentMaintenance({
  societyId,
  flatId,
}: {
  societyId: string;
  flatId: string;
}) {
  const [tickets, setTickets] = useState<MaintenanceTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    category: 'PLUMBING',
    priority: 'MEDIUM',
    title: '',
    description: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!societyId || !flatId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<MaintenanceTicket[]>(
        `/api/v1/societies/${societyId}/maintenance-tickets?flatId=${flatId}`,
      );
      setTickets(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load tickets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId, flatId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.description.trim()) return;
    setSubmitting(true);
    try {
      await apiRequest(`/api/v1/societies/${societyId}/maintenance-tickets`, {
        method: 'POST',
        body: JSON.stringify({
          flatId,
          category: form.category,
          priority: form.priority,
          title: form.title,
          description: form.description,
        }),
      });
      setCreateOpen(false);
      setForm({ category: 'PLUMBING', priority: 'MEDIUM', title: '', description: '' });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to submit maintenance ticket');
    } finally {
      setSubmitting(false);
    }
  };

  const openCount = tickets.filter((t) => t.status === 'OPEN').length;
  const inProgressCount = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const resolvedCount = tickets.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED').length;

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Maintenance & Helpdesk</h2>
          <span className="small muted">Raise issues for plumbing, electrical, carpentry, or common areas.</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Raise Ticket
          </button>
        </div>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      <div className="stat-rail" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">Open requests</div>
          <div className="stat-value">{openCount}</div>
          <div className="stat-note">awaiting technician dispatch</div>
        </div>
        <div className="stat">
          <div className="stat-label">In progress</div>
          <div className="stat-value">{inProgressCount}</div>
          <div className="stat-note">technician assigned</div>
        </div>
        <div className="stat">
          <div className="stat-label">Resolved / Closed</div>
          <div className="stat-value">{resolvedCount}</div>
          <div className="stat-note">completed work orders</div>
        </div>
      </div>

      {tickets.length === 0 && !loading ? (
        <EmptyState
          title="No active maintenance tickets"
          copy="Need something fixed in your flat or noticed a common area fault? Raise a ticket and society facility staff will attend."
          action={
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> Raise Ticket
            </button>
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {tickets.map((ticket) => (
            <div key={ticket.id} className="panel" style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TicketStatusBadge status={ticket.status} />
                  <TicketPriorityBadge priority={ticket.priority} />
                  <Badge tone="neutral">{ticket.category}</Badge>
                </div>
                <span className="small muted">
                  {new Date(ticket.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 650, margin: 0 }}>{ticket.title}</h3>
              <p style={{ color: 'var(--muted)', margin: 0 }}>{ticket.description}</p>
              {ticket.assignedStaff ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--success)', marginTop: 4 }}>
                  <Wrench size={13} /> Assigned technician: <strong>{ticket.assignedStaff}</strong>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {createOpen ? (
        <Modal title="Raise Maintenance Ticket" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} style={{ display: 'grid', gap: 14 }}>
            <div>
              <label className="context-label" htmlFor="ticket-category">Category</label>
              <select
                id="ticket-category"
                className="select"
                style={{ width: '100%' }}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                <option value="PLUMBING">Plumbing (Water leak, faucet, drain)</option>
                <option value="ELECTRICAL">Electrical (Switch, trip, fixture)</option>
                <option value="LIFT">Lift & Elevator</option>
                <option value="COMMON_AREA">Common Area / Hallway</option>
                <option value="CARPENTRY">Carpentry & Hardware</option>
              </select>
            </div>

            <div>
              <label className="context-label" htmlFor="ticket-priority">Priority</label>
              <select
                id="ticket-priority"
                className="select"
                style={{ width: '100%' }}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                <option value="LOW">Low (Routine maintenance)</option>
                <option value="MEDIUM">Medium (Standard issue)</option>
                <option value="HIGH">High (Impacting daily use)</option>
                <option value="URGENT">Urgent (Leak, hazard, emergency)</option>
              </select>
            </div>

            <div>
              <label className="context-label" htmlFor="ticket-title">Issue Summary</label>
              <input
                id="ticket-title"
                className="input"
                style={{ width: '100%' }}
                placeholder="Brief summary (e.g. Master bathroom sink clogged)"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </div>

            <div>
              <label className="context-label" htmlFor="ticket-desc">Detailed Description</label>
              <textarea
                id="ticket-desc"
                className="input"
                style={{ width: '100%', minHeight: 90 }}
                placeholder="Describe when the issue began and any specifics..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn" type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Ticket'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// =========================================================================
// 3. AMENITY BOOKINGS (RESIDENT)
// =========================================================================

const SAMPLE_AMENITIES = [
  { name: 'Clubhouse Hall', capacity: 50, hours: '08:00 - 22:00' },
  { name: 'Tennis Court', capacity: 4, hours: '06:00 - 21:00' },
  { name: 'Swimming Pool Cabana', capacity: 10, hours: '07:00 - 20:00' },
  { name: 'Badminton Court', capacity: 4, hours: '06:00 - 22:00' },
  { name: 'Community Lawn', capacity: 100, hours: '09:00 - 22:00' },
];

export function ResidentAmenities({
  societyId,
  flatId,
}: {
  societyId: string;
  flatId: string;
}) {
  const [bookings, setBookings] = useState<AmenityBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bookModalAmenity, setBookModalAmenity] = useState<string | null>(null);
  const [form, setForm] = useState({
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    startTime: '10:00',
    endTime: '12:00',
    guestCount: 2,
  });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<AmenityBooking[]>(`/api/v1/societies/${societyId}/amenity-bookings`);
      setBookings(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load bookings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handleBook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookModalAmenity) return;
    setSubmitting(true);
    setError('');

    const slotStart = new Date(`${form.date}T${form.startTime}:00`).toISOString();
    const slotEnd = new Date(`${form.date}T${form.endTime}:00`).toISOString();

    try {
      await apiRequest(`/api/v1/societies/${societyId}/amenity-bookings`, {
        method: 'POST',
        body: JSON.stringify({
          amenityName: bookModalAmenity,
          flatId,
          slotStart,
          slotEnd,
          guestCount: Number(form.guestCount) || 1,
        }),
      });
      setBookModalAmenity(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to complete amenity booking');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (bookingId: string) => {
    try {
      await apiRequest(`/api/v1/societies/${societyId}/amenity-bookings/${bookingId}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to cancel booking');
    }
  };

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Amenity Reservations</h2>
          <span className="small muted">Reserve society recreational amenities, courts, and community spaces.</span>
        </div>
        <button className="btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 24 }}>
        {SAMPLE_AMENITIES.map((item) => (
          <div key={item.name} className="panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Sparkles size={16} style={{ color: 'var(--amber)' }} />
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{item.name}</h3>
              </div>
              <div className="small muted" style={{ marginBottom: 12 }}>
                Hours: {item.hours} · Max capacity: {item.capacity} guests
              </div>
            </div>
            <button
              className="btn btn-small"
              type="button"
              onClick={() => setBookModalAmenity(item.name)}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Calendar size={13} /> Book Slot
            </button>
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: 16, fontWeight: 650, marginBottom: 10 }}>Active Society Bookings</h3>
      {bookings.length === 0 && !loading ? (
        <EmptyState title="No bookings scheduled" copy="Select an amenity above to reserve your preferred time slot." />
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {bookings.map((booking) => {
            const isConfirmed = booking.status === 'CONFIRMED';
            return (
              <div
                key={booking.id}
                className="panel"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  opacity: isConfirmed ? 1 : 0.6,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 650, fontSize: 15 }}>{booking.amenityName}</span>
                    <Badge tone={isConfirmed ? 'authorized' : 'denied'}>{booking.status}</Badge>
                    <span className="badge neutral">Flat {booking.flat.flatNumber}</span>
                  </div>
                  <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span>
                      <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
                      {new Date(booking.slotStart).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      –{' '}
                      {new Date(booking.slotEnd).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span>
                      Booked by: {getBookedByName(booking.bookedBy)} ({booking.guestCount} guests)
                    </span>
                  </div>
                </div>
                {isConfirmed ? (
                  <button
                    className="btn btn-small btn-ghost"
                    type="button"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => handleCancel(booking.id)}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {bookModalAmenity ? (
        <Modal title={`Book ${bookModalAmenity}`} onClose={() => setBookModalAmenity(null)}>
          <form onSubmit={handleBook} style={{ display: 'grid', gap: 14 }}>
            <div>
              <label className="context-label" htmlFor="book-date">Reservation Date</label>
              <input
                id="book-date"
                type="date"
                className="input"
                style={{ width: '100%' }}
                min={new Date().toISOString().split('T')[0]}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label className="context-label" htmlFor="book-start">Start Time</label>
                <input
                  id="book-start"
                  type="time"
                  className="input"
                  style={{ width: '100%' }}
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="context-label" htmlFor="book-end">End Time</label>
                <input
                  id="book-end"
                  type="time"
                  className="input"
                  style={{ width: '100%' }}
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  required
                />
              </div>
            </div>

            <div>
              <label className="context-label" htmlFor="book-guests">Estimated Guests</label>
              <input
                id="book-guests"
                type="number"
                min={1}
                max={50}
                className="input"
                style={{ width: '100%' }}
                value={form.guestCount}
                onChange={(e) => setForm({ ...form, guestCount: Number(e.target.value) })}
                required
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn" type="button" onClick={() => setBookModalAmenity(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Confirming...' : 'Confirm Reservation'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// =========================================================================
// 4. ADMIN ANNOUNCEMENT MANAGER
// =========================================================================

export function AdminAnnouncementsManager({ societyId }: { societyId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    content: '',
    category: 'GENERAL' as 'GENERAL' | 'EMERGENCY' | 'MAINTENANCE' | 'EVENT',
    pinned: false,
  });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<Announcement[]>(`/api/v1/societies/${societyId}/announcements`);
      setAnnouncements(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load announcements');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest(`/api/v1/societies/${societyId}/announcements`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setCreateOpen(false);
      setForm({ title: '', content: '', category: 'GENERAL', pinned: false });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to publish announcement');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/v1/societies/${societyId}/announcements/${id}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete announcement');
    }
  };

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Society Circulars & Announcements</h2>
          <span className="small muted">Publish official notices to all residents and community staff.</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Post Announcement
          </button>
        </div>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {announcements.length === 0 && !loading ? (
        <EmptyState
          title="No circulars published"
          copy="Click 'Post Announcement' to send emergency notices, maintenance schedules, or community updates."
          action={
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> Post Announcement
            </button>
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {announcements.map((ann) => (
            <div key={ann.id} className="panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ maxWidth: '80%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {ann.pinned ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--amber-ink)', fontWeight: 600, fontSize: 12 }}>
                      <Pin size={13} /> Pinned
                    </span>
                  ) : null}
                  <AnnouncementCategoryBadge category={ann.category} />
                  <span className="small muted">
                    {new Date(ann.createdAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 650, margin: '0 0 6px 0' }}>{ann.title}</h3>
                <p style={{ color: 'var(--ink-2)', margin: 0, whiteSpace: 'pre-line' }}>{ann.content}</p>
                <div className="small muted" style={{ marginTop: 8 }}>Author: {getAuthorName(ann.author)}</div>
              </div>
              <button
                className="btn btn-small btn-ghost"
                type="button"
                style={{ color: 'var(--danger)' }}
                onClick={() => handleDelete(ann.id)}
                aria-label="Delete announcement"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {createOpen ? (
        <Modal title="Publish New Announcement" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} style={{ display: 'grid', gap: 14 }}>
            <div>
              <label className="context-label" htmlFor="ann-title">Title</label>
              <input
                id="ann-title"
                className="input"
                style={{ width: '100%' }}
                placeholder="Notice title..."
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </div>

            <div>
              <label className="context-label" htmlFor="ann-cat">Category</label>
              <select
                id="ann-cat"
                className="select"
                style={{ width: '100%' }}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as any })}
              >
                <option value="GENERAL">General Notice</option>
                <option value="MAINTENANCE">Maintenance & Outages</option>
                <option value="EMERGENCY">Emergency / Urgent Safety</option>
                <option value="EVENT">Community Event</option>
              </select>
            </div>

            <div>
              <label className="context-label" htmlFor="ann-content">Notice Content</label>
              <textarea
                id="ann-content"
                className="input"
                style={{ width: '100%', minHeight: 120 }}
                placeholder="Full details of the announcement..."
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                required
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="ann-pinned"
                type="checkbox"
                checked={form.pinned}
                onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
              />
              <label htmlFor="ann-pinned" style={{ fontWeight: 600 }}>Pin to top of resident dashboard</label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn" type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Publishing...' : 'Publish Notice'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// =========================================================================
// 5. ADMIN HELPDESK & TICKETS
// =========================================================================

export function AdminHelpdeskManager({ societyId }: { societyId: string }) {
  const [tickets, setTickets] = useState<MaintenanceTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editTicket, setEditTicket] = useState<MaintenanceTicket | null>(null);
  const [assignee, setAssignee] = useState('');
  const [newStatus, setNewStatus] = useState<string>('IN_PROGRESS');

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<MaintenanceTicket[]>(`/api/v1/societies/${societyId}/maintenance-tickets`);
      setTickets(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load tickets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTicket) return;
    try {
      await apiRequest(`/api/v1/societies/${societyId}/maintenance-tickets/${editTicket.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: newStatus,
          assignedStaff: assignee,
        }),
      });
      setEditTicket(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to update ticket');
    }
  };

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Community Facility Helpdesk</h2>
          <span className="small muted">Manage resident service requests, plumbing/electrical tasks, and technicians.</span>
        </div>
        <button className="btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {tickets.length === 0 && !loading ? (
        <EmptyState title="No maintenance tickets" copy="Residents have not logged any facility requests yet." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', textAlign: 'left' }}>
            <thead>
              <tr>
                <th>Flat</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Assigned Staff</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{getFlatDisplay(t.flat)}</strong>
                  </td>
                  <td><Badge tone="neutral">{t.category}</Badge></td>
                  <td><TicketPriorityBadge priority={t.priority} /></td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.title}</div>
                    <div className="small muted" style={{ maxWidth: 260, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{t.description}</div>
                  </td>
                  <td><TicketStatusBadge status={t.status} /></td>
                  <td className="small">{t.assignedStaff || '—'}</td>
                  <td>
                    <button
                      className="btn btn-small"
                      type="button"
                      onClick={() => {
                        setEditTicket(t);
                        setAssignee(t.assignedStaff || '');
                        setNewStatus(t.status);
                      }}
                    >
                      Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editTicket ? (
        <Modal title={`Update Ticket: ${editTicket.title}`} onClose={() => setEditTicket(null)}>
          <form onSubmit={handleUpdate} style={{ display: 'grid', gap: 14 }}>
            <div>
              <div className="context-label">Flat</div>
              <div>{getFlatDisplay(editTicket.flat)}</div>
            </div>

            <div>
              <label className="context-label" htmlFor="ticket-status-select">Status</label>
              <select
                id="ticket-status-select"
                className="select"
                style={{ width: '100%' }}
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
              >
                <option value="OPEN">Open (Pending)</option>
                <option value="IN_PROGRESS">In Progress (Work underway)</option>
                <option value="RESOLVED">Resolved (Work completed)</option>
                <option value="CLOSED">Closed (Archived)</option>
              </select>
            </div>

            <div>
              <label className="context-label" htmlFor="ticket-staff-input">Assign Staff / Technician</label>
              <input
                id="ticket-staff-input"
                className="input"
                style={{ width: '100%' }}
                placeholder="e.g. Ramesh Plumber, Deepak Electrician"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <button className="btn" type="button" onClick={() => setEditTicket(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit">
                Save Changes
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

// =========================================================================
// 6. ADMIN AMENITIES MANAGER
// =========================================================================

export function AdminAmenitiesManager({ societyId }: { societyId: string }) {
  const [bookings, setBookings] = useState<AmenityBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<AmenityBooking[]>(`/api/v1/societies/${societyId}/amenity-bookings`);
      setBookings(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load bookings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handleCancel = async (bookingId: string) => {
    try {
      await apiRequest(`/api/v1/societies/${societyId}/amenity-bookings/${bookingId}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to cancel booking');
    }
  };

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Community Facility Bookings</h2>
          <span className="small muted">View and manage all resident reservations for society amenities.</span>
        </div>
        <button className="btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {bookings.length === 0 && !loading ? (
        <EmptyState title="No bookings reserved" copy="No resident has booked an amenity yet." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', textAlign: 'left' }}>
            <thead>
              <tr>
                <th>Amenity</th>
                <th>Flat</th>
                <th>Booked By</th>
                <th>Time Window</th>
                <th>Guests</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => {
                const isConfirmed = b.status === 'CONFIRMED';
                return (
                  <tr key={b.id} style={{ opacity: isConfirmed ? 1 : 0.6 }}>
                    <td><strong>{b.amenityName}</strong></td>
                    <td>{getFlatDisplay(b.flat)}</td>
                    <td>{getBookedByName(b.bookedBy)}</td>
                    <td>
                      {new Date(b.slotStart).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      –{' '}
                      {new Date(b.slotEnd).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>{b.guestCount}</td>
                    <td><Badge tone={isConfirmed ? 'authorized' : 'denied'}>{b.status}</Badge></td>
                    <td>
                      {isConfirmed ? (
                        <button
                          className="btn btn-small btn-ghost"
                          type="button"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => handleCancel(b.id)}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// 7. MAINTENANCE BILLING / INVOICING (RESIDENT)
// =========================================================================

export function ResidentInvoicesView({ societyId }: { societyId: string }) {
  const [invoices, setInvoices] = useState<MaintenanceInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [payingInvoice, setPayingInvoice] = useState<MaintenanceInvoice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<MaintenanceInvoice[]>(`/api/v1/societies/${societyId}/invoices`);
      setInvoices(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load maintenance invoices');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingInvoice) return;
    setSubmitting(true);
    try {
      const order = await apiRequest<{ orderId: string }>(
        `/api/v1/societies/${societyId}/invoices/${payingInvoice.id}/payment/razorpay/order`,
        { method: 'POST' },
      );
      await apiRequest(
        `/api/v1/societies/${societyId}/invoices/${payingInvoice.id}/payment/razorpay/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            razorpayOrderId: order.orderId,
            razorpayPaymentId: `pay_${Date.now()}`,
            razorpaySignature: 'mock_sig_ok',
          }),
        },
      );
      setPayingInvoice(null);
      await load();
    } catch (err: any) {
      alert(err?.message || 'Payment gateway failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Maintenance & Society Dues</h2>
          <span className="small muted">View outstanding invoices, payment history, and settle community dues.</span>
        </div>
        <button className="btn" type="button" onClick={load} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {invoices.length === 0 && !loading ? (
        <EmptyState
          title="All dues settled"
          copy="You have no outstanding or pending maintenance invoices for your flat."
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {invoices.map((inv) => {
            const isSettled = inv.status === 'PAID';
            return (
              <div
                key={inv.id}
                className="card"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '16px 20px',
                  opacity: inv.status === 'CANCELLED' ? 0.6 : 1,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <strong style={{ fontSize: 16 }}>{inv.title}</strong>
                    <InvoiceStatusBadge status={inv.status} />
                  </div>
                  <div className="small muted" style={{ display: 'flex', gap: 16 }}>
                    <span>Flat: {getFlatDisplay(inv.flat)}</span>
                    <span>Due: {new Date(inv.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    {inv.paidAt && (
                      <span style={{ color: 'var(--success)' }}>
                        Paid on {new Date(inv.paidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        {inv.paymentReference ? ` (${inv.paymentReference})` : ''}
                      </span>
                    )}
                  </div>
                  {inv.description ? (
                    <p className="small muted" style={{ margin: '6px 0 0' }}>{inv.description}</p>
                  ) : null}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: isSettled ? 'var(--text-muted)' : 'var(--text)' }}>
                    ₹{inv.amount.toLocaleString('en-IN')}
                  </div>
                  {!isSettled && inv.status !== 'CANCELLED' ? (
                    <button
                      className="btn btn-primary btn-small"
                      type="button"
                      onClick={() => setPayingInvoice(inv)}
                    >
                      <CreditCard size={14} /> Settle Bill
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {payingInvoice && (
        <Modal title={`Settle Bill: ${payingInvoice.title}`} onClose={() => setPayingInvoice(null)}>
          <form onSubmit={handlePay} className="stack">
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
                ₹{payingInvoice.amount.toLocaleString('en-IN')}
              </div>
              <p className="small muted">
                Pay maintenance dues for <strong>{getFlatDisplay(payingInvoice.flat)}</strong>.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" type="button" onClick={() => setPayingInvoice(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Processing...' : 'Pay Online (Razorpay / UPI)'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// =========================================================================
// 8. MAINTENANCE BILLING / INVOICING (ADMIN)
// =========================================================================

export function AdminInvoicesManager({
  societyId,
  flats,
}: {
  societyId: string;
  flats?: { id: string; flatNumber: string; building?: { name: string } | string }[];
}) {
  const [invoices, setInvoices] = useState<MaintenanceInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'PAID' | 'OVERDUE'>('ALL');

  // Form states
  const [flatId, setFlatId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('4500');
  const [dueDate, setDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!societyId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<MaintenanceInvoice[]>(`/api/v1/societies/${societyId}/invoices`);
      setInvoices(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [societyId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!flatId || !title || !amount || !dueDate) {
      alert('Please fill out all required fields');
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest(`/api/v1/societies/${societyId}/invoices`, {
        method: 'POST',
        body: JSON.stringify({
          flatId,
          title: title.trim(),
          description: description.trim() || undefined,
          amount: parseFloat(amount),
          dueDate: new Date(dueDate).toISOString(),
        }),
      });
      setModalOpen(false);
      setTitle('');
      setDescription('');
      setDueDate('');
      await load();
    } catch (err: any) {
      alert(err?.message || 'Failed to generate invoice');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    if (!window.confirm('Cancel this maintenance invoice?')) return;
    try {
      await apiRequest(`/api/v1/societies/${societyId}/invoices/${id}/cancel`, {
        method: 'PATCH',
      });
      await load();
    } catch (err: any) {
      alert(err?.message || 'Failed to cancel invoice');
    }
  };

  const filtered = invoices.filter((inv) => {
    if (filter === 'ALL') return true;
    return inv.status === filter;
  });

  const totalInvoiced = invoices.filter((i) => i.status !== 'CANCELLED').reduce((acc, i) => acc + i.amount, 0);
  const totalCollected = invoices.filter((i) => i.status === 'PAID').reduce((acc, i) => acc + i.amount, 0);
  const totalPending = invoices.filter((i) => i.status === 'PENDING' || i.status === 'OVERDUE').reduce((acc, i) => acc + i.amount, 0);

  return (
    <div className="section-gap">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Society Maintenance Billing & Ledger</h2>
          <span className="small muted">Generate unit invoices, track payment status, and reconcile society dues.</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setModalOpen(true)}>
            <Plus size={14} /> Generate Invoice
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="small muted">Total Invoiced</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>₹{totalInvoiced.toLocaleString('en-IN')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="small muted">Total Collected</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--success)' }}>₹{totalCollected.toLocaleString('en-IN')}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="small muted">Outstanding Dues</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: totalPending > 0 ? 'var(--amber)' : 'inherit' }}>₹{totalPending.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['ALL', 'PENDING', 'OVERDUE', 'PAID'] as const).map((s) => (
          <button
            key={s}
            className={`btn btn-small ${filter === s ? 'btn-primary' : 'btn-ghost'}`}
            type="button"
            onClick={() => setFilter(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {error ? <Notice danger>{error}</Notice> : null}

      {filtered.length === 0 && !loading ? (
        <EmptyState title="No invoices found" copy="No maintenance invoices match the current filter." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', textAlign: 'left' }}>
            <thead>
              <tr>
                <th>Invoice Title</th>
                <th>Flat</th>
                <th>Amount</th>
                <th>Due Date</th>
                <th>Status</th>
                <th>Settlement</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => (
                <tr key={inv.id} style={{ opacity: inv.status === 'CANCELLED' ? 0.6 : 1 }}>
                  <td><strong>{inv.title}</strong></td>
                  <td>{getFlatDisplay(inv.flat)}</td>
                  <td><strong>₹{inv.amount.toLocaleString('en-IN')}</strong></td>
                  <td>{new Date(inv.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td><InvoiceStatusBadge status={inv.status} /></td>
                  <td className="small muted">
                    {inv.paidAt ? (
                      <>
                        <span>{inv.paymentReference || 'Paid'}</span><br />
                        <span>{new Date(inv.paidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                      </>
                    ) : '—'}
                  </td>
                  <td>
                    {inv.status !== 'PAID' && inv.status !== 'CANCELLED' ? (
                      <button
                        className="btn btn-small btn-ghost"
                        type="button"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => handleCancel(inv.id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <Modal title="Generate Maintenance Invoice" onClose={() => setModalOpen(false)}>
          <form onSubmit={handleCreate} className="stack">
            <div className="field">
              <label className="label" htmlFor="invoice-flat">Billed Flat</label>
              {flats && flats.length > 0 ? (
                <select id="invoice-flat" className="input" value={flatId} onChange={(e) => setFlatId(e.target.value)} required>
                  <option value="">Select flat...</option>
                  {flats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {getFlatDisplay(f)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="invoice-flat"
                  className="input"
                  placeholder="Flat UUID"
                  value={flatId}
                  onChange={(e) => setFlatId(e.target.value)}
                  required
                />
              )}
            </div>
            <div className="field">
              <label className="label" htmlFor="invoice-title">Invoice Title</label>
              <input
                id="invoice-title"
                className="input"
                type="text"
                placeholder="e.g. Monthly Maintenance - November 2026"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="invoice-amount">Amount (₹)</label>
              <input
                id="invoice-amount"
                className="input"
                type="number"
                min="1"
                step="any"
                placeholder="4500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="invoice-due-date">Due Date</label>
              <input
                id="invoice-due-date"
                className="input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="invoice-description">Description / Notes (Optional)</label>
              <textarea
                id="invoice-description"
                className="input"
                rows={2}
                placeholder="Breakdown of charges..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button className="btn btn-ghost" type="button" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Generating...' : 'Issue Invoice'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}


