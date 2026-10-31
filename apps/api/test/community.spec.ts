import { AppException } from '../src/common/app.exception';
import { AuthzService } from '../src/common/authz.service';
import { AuditService } from '../src/common/audit.service';
import { CommunityService } from '../src/societies/community.service';
import { JwtUser } from '../src/auth/jwt-auth.guard';

describe('Stage 6 Community Life Service Suite (Announcements, Maintenance, Amenities)', () => {
  const SOCIETY_A = 'society-aaa-111';
  const SOCIETY_B = 'society-bbb-222';
  const FLAT_101 = 'flat-101-aaa';
  const FLAT_102 = 'flat-102-aaa';
  const FLAT_B_201 = 'flat-201-bbb';

  const adminUser: JwtUser = {
    sub: 'user-admin',
    email: 'admin@a.com',
    name: 'Admin A',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  const residentUser1: JwtUser = {
    sub: 'user-res-1',
    email: 'res1@a.com',
    name: 'Resident 1',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  const residentUser2: JwtUser = {
    sub: 'user-res-2',
    email: 'res2@a.com',
    name: 'Resident 2',
    isPlatformAdmin: false,
    mustChangePassword: false,
  };

  let mockPrisma: any;
  let authzService: AuthzService;
  let auditService: AuditService;
  let communityService: CommunityService;

  beforeEach(() => {
    mockPrisma = {
      announcement: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      maintenanceTicket: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      amenityBooking: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      maintenanceInvoice: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      flat: {
        findUnique: jest.fn(),
      },
      residentFlatMembership: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      societyMembership: {
        findUnique: jest.fn(),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    authzService = new AuthzService(mockPrisma as any);
    auditService = new AuditService(mockPrisma as any);
    communityService = new CommunityService(mockPrisma as any, authzService, auditService);
  });

  // =========================================================================
  // 1. ANNOUNCEMENTS
  // =========================================================================
  describe('Announcements & Notice Board', () => {
    it('creates an announcement with category and pinned state', async () => {
      mockPrisma.announcement.create.mockResolvedValue({
        id: 'ann-1',
        societyId: SOCIETY_A,
        title: 'Water shutdown notice',
        content: 'Main water pump maintenance tomorrow 10am-2pm',
        category: 'MAINTENANCE',
        pinned: true,
        author: { name: 'Admin A' },
      });

      const res = await communityService.createAnnouncement(adminUser, SOCIETY_A, {
        title: 'Water shutdown notice',
        content: 'Main water pump maintenance tomorrow 10am-2pm',
        category: 'MAINTENANCE',
        pinned: true,
      });

      expect(res.id).toBe('ann-1');
      expect(res.category).toBe('MAINTENANCE');
      expect(res.pinned).toBe(true);
      expect(mockPrisma.announcement.create).toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ANNOUNCEMENT_CREATED' }),
        }),
      );
    });

    it('lists announcements ordered by pinned desc, createdAt desc', async () => {
      mockPrisma.announcement.findMany.mockResolvedValue([
        { id: 'ann-pinned', pinned: true, title: 'Emergency Fire Drill' },
        { id: 'ann-recent', pinned: false, title: 'Diwali Party' },
      ]);

      const list = await communityService.listAnnouncements(SOCIETY_A);
      expect(list.length).toBe(2);
      expect(list[0].id).toBe('ann-pinned');
      expect(mockPrisma.announcement.findMany).toHaveBeenCalledWith({
        where: { societyId: SOCIETY_A },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        include: { author: { select: { name: true } } },
      });
    });

    it('prevents deleting an announcement belonging to a different society', async () => {
      mockPrisma.announcement.findUnique.mockResolvedValue({
        id: 'ann-b',
        societyId: SOCIETY_B,
        title: 'Foreign announcement',
      });

      await expect(
        communityService.deleteAnnouncement(adminUser, SOCIETY_A, 'ann-b'),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'ANNOUNCEMENT_NOT_FOUND' }),
        }),
      );
    });

    it('allows deleting an announcement within the society', async () => {
      mockPrisma.announcement.findUnique.mockResolvedValue({
        id: 'ann-1',
        societyId: SOCIETY_A,
        title: 'To be deleted',
      });
      mockPrisma.announcement.delete.mockResolvedValue({});

      const res = await communityService.deleteAnnouncement(adminUser, SOCIETY_A, 'ann-1');
      expect(res.ok).toBe(true);
      expect(mockPrisma.announcement.delete).toHaveBeenCalledWith({ where: { id: 'ann-1' } });
    });
  });

  // =========================================================================
  // 2. MAINTENANCE TICKETS
  // =========================================================================
  describe('Maintenance Tickets', () => {
    it('prevents creating a ticket for a flat belonging to a different society', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_B_201,
        building: { societyId: SOCIETY_B },
      });

      await expect(
        communityService.createTicket(residentUser1, SOCIETY_A, {
          flatId: FLAT_B_201,
          category: 'PLUMBING',
          title: 'Pipe leak',
          description: 'Bathroom sink leaking',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'FLAT_NOT_FOUND' }),
        }),
      );
    });

    it('prevents a resident from raising a ticket for a flat they do not belong to', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_102,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.societyMembership.findUnique.mockResolvedValue({
        role: 'RESIDENT',
        status: 'ACTIVE',
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue(null); // Not a resident of flat 102

      await expect(
        communityService.createTicket(residentUser1, SOCIETY_A, {
          flatId: FLAT_102,
          category: 'ELECTRICAL',
          title: 'Power trip',
          description: 'Tripping circuit breaker',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'NOT_YOUR_FLAT' }),
        }),
      );
    });

    it('allows a resident to raise a ticket for their verified flat', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.societyMembership.findUnique.mockResolvedValue({
        role: 'RESIDENT',
        status: 'ACTIVE',
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rfm-1', flatId: FLAT_101 });
      mockPrisma.maintenanceTicket.create.mockResolvedValue({
        id: 'tkt-1',
        flatId: FLAT_101,
        title: 'Leaking pipe',
        category: 'PLUMBING',
        priority: 'HIGH',
        status: 'OPEN',
      });

      const ticket = await communityService.createTicket(residentUser1, SOCIETY_A, {
        flatId: FLAT_101,
        category: 'PLUMBING',
        priority: 'HIGH',
        title: 'Leaking pipe',
        description: 'Under kitchen sink',
      });

      expect(ticket.id).toBe('tkt-1');
      expect(ticket.status).toBe('OPEN');
      expect(mockPrisma.maintenanceTicket.create).toHaveBeenCalled();
    });

    it('allows admin to update ticket status and assign staff', async () => {
      mockPrisma.maintenanceTicket.findUnique.mockResolvedValue({
        id: 'tkt-1',
        societyId: SOCIETY_A,
        status: 'OPEN',
      });
      mockPrisma.maintenanceTicket.update.mockResolvedValue({
        id: 'tkt-1',
        status: 'IN_PROGRESS',
        assignedStaff: 'Ramesh Plumber',
      });

      const updated = await communityService.updateTicket(adminUser, SOCIETY_A, 'tkt-1', {
        status: 'IN_PROGRESS',
        assignedStaff: 'Ramesh Plumber',
      });

      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.assignedStaff).toBe('Ramesh Plumber');
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. AMENITY BOOKINGS
  // =========================================================================
  describe('Amenity Bookings & Double-Booking Prevention', () => {
    it('rejects booking with slot in the past', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rfm-1' });

      const pastStart = new Date(Date.now() - 3600_000).toISOString();
      const pastEnd = new Date(Date.now() - 1800_000).toISOString();

      await expect(
        communityService.createBooking(residentUser1, SOCIETY_A, {
          amenityName: 'Clubhouse',
          flatId: FLAT_101,
          slotStart: pastStart,
          slotEnd: pastEnd,
          guestCount: 10,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SLOT_IN_PAST' }),
        }),
      );
    });

    it('rejects booking with invalid time range (end before start)', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rfm-1' });

      const futureStart = new Date(Date.now() + 7200_000).toISOString();
      const futureEnd = new Date(Date.now() + 3600_000).toISOString();

      await expect(
        communityService.createBooking(residentUser1, SOCIETY_A, {
          amenityName: 'Tennis Court',
          flatId: FLAT_101,
          slotStart: futureStart,
          slotEnd: futureEnd,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'INVALID_TIME_RANGE' }),
        }),
      );
    });

    it('prevents double-booking when overlapping confirmed booking exists', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rfm-1' });

      const start = new Date(Date.now() + 3600_000).toISOString();
      const end = new Date(Date.now() + 7200_000).toISOString();

      // Conflicting booking exists
      mockPrisma.amenityBooking.findFirst.mockResolvedValue({
        id: 'booking-existing',
        amenityName: 'Clubhouse',
        status: 'CONFIRMED',
      });

      await expect(
        communityService.createBooking(residentUser1, SOCIETY_A, {
          amenityName: 'Clubhouse',
          flatId: FLAT_101,
          slotStart: start,
          slotEnd: end,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'AMENITY_SLOT_UNAVAILABLE' }),
        }),
      );
    });

    it('creates confirmed booking when slot is available', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({ id: 'rfm-1' });

      const start = new Date(Date.now() + 3600_000).toISOString();
      const end = new Date(Date.now() + 7200_000).toISOString();

      mockPrisma.amenityBooking.findFirst.mockResolvedValue(null); // No conflict
      mockPrisma.amenityBooking.create.mockResolvedValue({
        id: 'book-1',
        amenityName: 'Clubhouse',
        status: 'CONFIRMED',
        slotStart: new Date(start),
        slotEnd: new Date(end),
      });

      const booking = await communityService.createBooking(residentUser1, SOCIETY_A, {
        amenityName: 'Clubhouse',
        flatId: FLAT_101,
        slotStart: start,
        slotEnd: end,
        guestCount: 15,
      });

      expect(booking.id).toBe('book-1');
      expect(booking.status).toBe('CONFIRMED');
      expect(mockPrisma.amenityBooking.create).toHaveBeenCalled();
    });

    it('prevents resident from cancelling another resident booking', async () => {
      mockPrisma.amenityBooking.findUnique.mockResolvedValue({
        id: 'book-1',
        societyId: SOCIETY_A,
        bookedById: residentUser1.sub,
        amenityName: 'Clubhouse',
      });

      await expect(
        communityService.cancelBooking(residentUser2, 'RESIDENT', SOCIETY_A, 'book-1'),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'NOT_YOUR_BOOKING' }),
        }),
      );
    });

    it('allows resident to cancel their own booking', async () => {
      mockPrisma.amenityBooking.findUnique.mockResolvedValue({
        id: 'book-1',
        societyId: SOCIETY_A,
        bookedById: residentUser1.sub,
        amenityName: 'Clubhouse',
      });
      mockPrisma.amenityBooking.update.mockResolvedValue({
        id: 'book-1',
        status: 'CANCELLED',
      });

      const res = await communityService.cancelBooking(residentUser1, 'RESIDENT', SOCIETY_A, 'book-1');
      expect(res.status).toBe('CANCELLED');
    });

    it('allows society admin to cancel any booking', async () => {
      mockPrisma.amenityBooking.findUnique.mockResolvedValue({
        id: 'book-1',
        societyId: SOCIETY_A,
        bookedById: residentUser1.sub,
        amenityName: 'Clubhouse',
      });
      mockPrisma.amenityBooking.update.mockResolvedValue({
        id: 'book-1',
        status: 'CANCELLED',
      });

      const res = await communityService.cancelBooking(adminUser, 'SOCIETY_ADMIN', SOCIETY_A, 'book-1');
      expect(res.status).toBe('CANCELLED');
    });
  });

  // =========================================================================
  // 4. MAINTENANCE BILLING & INVOICING
  // =========================================================================
  describe('Maintenance Billing & Invoicing', () => {
    it('creates a maintenance invoice for a valid flat in the society', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A, name: 'Tower A' },
      });
      mockPrisma.maintenanceInvoice.create.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        flatId: FLAT_101,
        title: 'November 2026 Maintenance',
        amount: 4500,
        status: 'PENDING',
        dueDate: new Date('2026-11-15T00:00:00Z'),
        flat: { id: FLAT_101, flatNumber: '101', building: { name: 'Tower A' } },
      });

      const res = await communityService.createInvoice(adminUser, SOCIETY_A, {
        flatId: FLAT_101,
        title: 'November 2026 Maintenance',
        amount: 4500,
        dueDate: '2026-11-15T00:00:00Z',
      });

      expect(res.id).toBe('inv-1');
      expect(res.amount).toBe(4500);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'INVOICE_CREATED',
            entityType: 'MaintenanceInvoice',
          }),
        }),
      );
    });

    it('rejects creating an invoice for a foreign-society flat', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_B_201,
        building: { societyId: SOCIETY_B, name: 'Tower B' },
      });

      await expect(
        communityService.createInvoice(adminUser, SOCIETY_A, {
          flatId: FLAT_B_201,
          title: 'November 2026 Maintenance',
          amount: 4500,
          dueDate: '2026-11-15T00:00:00Z',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'FLAT_NOT_FOUND' }),
        }),
      );
    });

    it('rejects creating an invoice with an invalid due date', async () => {
      mockPrisma.flat.findUnique.mockResolvedValue({
        id: FLAT_101,
        building: { societyId: SOCIETY_A, name: 'Tower A' },
      });

      await expect(
        communityService.createInvoice(adminUser, SOCIETY_A, {
          flatId: FLAT_101,
          title: 'November 2026 Maintenance',
          amount: 4500,
          dueDate: 'not-a-valid-date',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'INVALID_DUE_DATE' }),
        }),
      );
    });

    it('lists invoices scoped to resident flats when queried by a RESIDENT', async () => {
      mockPrisma.residentFlatMembership.findMany.mockResolvedValue([{ flatId: FLAT_101 }]);
      mockPrisma.maintenanceInvoice.findMany.mockResolvedValue([
        {
          id: 'inv-1',
          societyId: SOCIETY_A,
          flatId: FLAT_101,
          amount: 4500,
          status: 'PENDING',
          dueDate: new Date(Date.now() + 86400000), // tomorrow
          flat: { id: FLAT_101, flatNumber: '101', building: { name: 'Tower A' } },
          paidBy: null,
        },
      ]);

      const res = await communityService.listInvoices(residentUser1, 'RESIDENT', SOCIETY_A);
      expect(res).toHaveLength(1);
      expect(mockPrisma.maintenanceInvoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { societyId: SOCIETY_A, flatId: { in: [FLAT_101] } },
        }),
      );
    });

    it('marks pending invoices as OVERDUE if due date has passed', async () => {
      mockPrisma.maintenanceInvoice.findMany.mockResolvedValue([
        {
          id: 'inv-past',
          societyId: SOCIETY_A,
          flatId: FLAT_101,
          amount: 4500,
          status: 'PENDING',
          dueDate: new Date(Date.now() - 86400000), // yesterday
          flat: { id: FLAT_101, flatNumber: '101', building: { name: 'Tower A' } },
          paidBy: null,
        },
      ]);

      const res = await communityService.listInvoices(adminUser, 'SOCIETY_ADMIN', SOCIETY_A);
      expect(res[0].status).toBe('OVERDUE');
    });

    it('allows resident to pay their own flat invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        flatId: FLAT_101,
        amount: 4500,
        status: 'PENDING',
        flat: { id: FLAT_101, building: { societyId: SOCIETY_A } },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue({
        id: 'rfm-1',
        flatId: FLAT_101,
        userId: residentUser1.sub,
      });
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        id: 'inv-1',
        status: 'PAID',
        paidAt: new Date(),
        paidById: residentUser1.sub,
        paymentReference: 'UPI-12345',
        flat: { id: FLAT_101, flatNumber: '101', building: { name: 'Tower A' } },
        paidBy: { id: residentUser1.sub, name: 'Resident 1', email: 'res1@a.com' },
      });

      const res = await communityService.recordPayment(residentUser1, 'RESIDENT', SOCIETY_A, 'inv-1', {
        paymentReference: 'UPI-12345',
      });

      expect(res.status).toBe('PAID');
      expect(res.paymentReference).toBe('UPI-12345');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'INVOICE_PAID' }),
        }),
      );
    });

    it('prevents resident from paying an invoice for another flat', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        flatId: FLAT_101,
        amount: 4500,
        status: 'PENDING',
        flat: { id: FLAT_101, building: { societyId: SOCIETY_A } },
      });
      mockPrisma.residentFlatMembership.findFirst.mockResolvedValue(null);

      await expect(
        communityService.recordPayment(residentUser2, 'RESIDENT', SOCIETY_A, 'inv-1', {}),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'NOT_YOUR_FLAT' }),
        }),
      );
    });

    it('rejects paying an already settled invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        flatId: FLAT_101,
        amount: 4500,
        status: 'PAID',
        flat: { id: FLAT_101, building: { societyId: SOCIETY_A } },
      });

      await expect(
        communityService.recordPayment(residentUser1, 'RESIDENT', SOCIETY_A, 'inv-1', {}),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'INVOICE_ALREADY_PAID' }),
        }),
      );
    });

    it('rejects paying a cancelled invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        flatId: FLAT_101,
        amount: 4500,
        status: 'CANCELLED',
        flat: { id: FLAT_101, building: { societyId: SOCIETY_A } },
      });

      await expect(
        communityService.recordPayment(residentUser1, 'RESIDENT', SOCIETY_A, 'inv-1', {}),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'INVOICE_CANCELLED' }),
        }),
      );
    });

    it('allows society admin to cancel an unpaid invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        status: 'PENDING',
        title: 'November 2026 Maintenance',
      });
      mockPrisma.maintenanceInvoice.update.mockResolvedValue({
        id: 'inv-1',
        status: 'CANCELLED',
      });

      const res = await communityService.cancelInvoice(adminUser, SOCIETY_A, 'inv-1');
      expect(res.status).toBe('CANCELLED');
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'INVOICE_CANCELLED' }),
        }),
      );
    });

    it('prevents society admin from cancelling an already paid invoice', async () => {
      mockPrisma.maintenanceInvoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        societyId: SOCIETY_A,
        status: 'PAID',
        title: 'November 2026 Maintenance',
      });

      await expect(
        communityService.cancelInvoice(adminUser, SOCIETY_A, 'inv-1'),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'INVOICE_ALREADY_PAID' }),
        }),
      );
    });
  });
});

