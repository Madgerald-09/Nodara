const anchor = require('@coral-xyz/anchor')
const { assert } = require('chai')
const { Keypair, PublicKey, SystemProgram } = require('@solana/web3.js')
const idl = require('../target/idl/nodara_tickets.json')

describe('nodara_tickets', function () {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const program = new anchor.Program(idl, provider)
  const organizer = provider.wallet.publicKey

  function newUuidBytes() {
    return Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16))
  }

  function eventAddress(eventId) {
    return PublicKey.findProgramAddressSync([Buffer.from('event'), Buffer.from(eventId)], program.programId)[0]
  }

  function ticketAddress(event, ticketId) {
    return PublicKey.findProgramAddressSync([Buffer.from('ticket'), event.toBuffer(), Buffer.from(ticketId)], program.programId)[0]
  }

  async function createEvent(allowTransfers) {
    const eventId = newUuidBytes()
    const event = eventAddress(eventId)
    await program.methods.createEvent(eventId, allowTransfers)
      .accountsStrict({ organizer, event, systemProgram: SystemProgram.programId }).rpc()
    return { eventId, event }
  }

  async function issueTicket(allowTransfers, owner = Keypair.generate()) {
    const { eventId, event } = await createEvent(allowTransfers)
    const ticketId = newUuidBytes()
    const ticket = ticketAddress(event, ticketId)
    await program.methods.registerTicket(ticketId)
      .accountsStrict({ organizer, event, initialOwner: owner.publicKey, ticket, systemProgram: SystemProgram.programId }).rpc()
    return { eventId, event, ticketId, ticket, owner }
  }

  async function fund(key) {
    const signature = await provider.connection.requestAirdrop(key.publicKey, anchor.web3.LAMPORTS_PER_SOL)
    const blockhash = await provider.connection.getLatestBlockhash()
    await provider.connection.confirmTransaction({ signature, ...blockhash }, 'confirmed')
  }

  async function expectRejected(action, expected) {
    let failure
    try { await action } catch (error) { failure = error }
    assert.exists(failure, `Expected transaction rejection containing one of: ${expected.join(', ')}`)
    const details = [failure.message, failure.error?.errorCode?.code, ...(failure.logs || [])].join(' ').toLowerCase()
    assert.isTrue(expected.some(code => details.includes(code.toLowerCase())), `Unexpected rejection: ${failure.message}`)
  }

  it('registers a ticket when signed by its event organiser', async () => {
    const { event, ticketId, ticket, owner } = await issueTicket(true)
    const record = await program.account.ticketRecord.fetch(ticket)
    assert.deepEqual(record.ticketId, ticketId)
    assert.equal(record.event.toBase58(), event.toBase58())
    assert.equal(record.issuer.toBase58(), organizer.toBase58())
    assert.equal(record.owner.toBase58(), owner.publicKey.toBase58())
    assert.isTrue(record.valid)
    assert.isFalse(record.checkedIn)
    assert.equal(record.transferCount, 0)
  })

  it('rejects registration signed by a wallet that does not organise the event', async () => {
    const { event } = await createEvent(true)
    const attacker = Keypair.generate()
    await fund(attacker)
    const ticketId = newUuidBytes()
    await expectRejected(program.methods.registerTicket(ticketId)
      .accountsStrict({ organizer: attacker.publicKey, event, initialOwner: attacker.publicKey, ticket: ticketAddress(event, ticketId), systemProgram: SystemProgram.programId })
      .signers([attacker]).rpc(), ['constrainthasone', 'organizer'])
  })

  it('prevents registering the same event ticket PDA twice', async () => {
    const issued = await issueTicket(true)
    await expectRejected(program.methods.registerTicket(issued.ticketId)
      .accountsStrict({ organizer, event: issued.event, initialOwner: issued.owner.publicKey, ticket: issued.ticket, systemProgram: SystemProgram.programId }).rpc(),
    ['already in use', 'alreadyinitialized', 'accountalreadyinuse'])
  })

  it('allows the current owner to transfer and stores an immutable receipt PDA', async () => {
    const issued = await issueTicket(true)
    const recipient = Keypair.generate()
    await fund(issued.owner)
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    await program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ currentOwner: issued.owner.publicKey, event: issued.event, ticket: issued.ticket, recipient: recipient.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([issued.owner]).rpc()
    const record = await program.account.ticketRecord.fetch(issued.ticket)
    const transfer = await program.account.transferReceipt.fetch(receipt)
    assert.equal(record.owner.toBase58(), recipient.publicKey.toBase58())
    assert.equal(record.transferCount, 1)
    assert.equal(transfer.from.toBase58(), issued.owner.publicKey.toBase58())
    assert.equal(transfer.to.toBase58(), recipient.publicKey.toBase58())
    assert.equal(transfer.sequence, 0)
  })

  it('rejects a transfer signed by a wallet that is not the current owner', async () => {
    const issued = await issueTicket(true)
    const attacker = Keypair.generate()
    const recipient = Keypair.generate()
    await fund(attacker)
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    await expectRejected(program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ currentOwner: attacker.publicKey, event: issued.event, ticket: issued.ticket, recipient: recipient.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([attacker]).rpc(), ['notowner'])
  })

  it('rejects a default-key recipient and a self-transfer', async () => {
    const issued = await issueTicket(true)
    await fund(issued.owner)
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    const accounts = { currentOwner: issued.owner.publicKey, event: issued.event, ticket: issued.ticket, receipt, systemProgram: SystemProgram.programId }
    await expectRejected(program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ ...accounts, recipient: PublicKey.default }).signers([issued.owner]).rpc(), ['invalidrecipient'])
    await expectRejected(program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ ...accounts, recipient: issued.owner.publicKey }).signers([issued.owner]).rpc(), ['sameowner'])
  })

  it('does not apply a replayed transfer transaction more than once', async () => {
    const issued = await issueTicket(true)
    const recipient = Keypair.generate()
    await fund(issued.owner)
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    const transaction = await program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ currentOwner: issued.owner.publicKey, event: issued.event, ticket: issued.ticket, recipient: recipient.publicKey, receipt, systemProgram: SystemProgram.programId }).transaction()
    await provider.sendAndConfirm(transaction, [issued.owner])
    try { await provider.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true }) } catch { /* A validator may reject the already processed signature. */ }
    const record = await program.account.ticketRecord.fetch(issued.ticket)
    assert.equal(record.owner.toBase58(), recipient.publicKey.toBase58())
    assert.equal(record.transferCount, 1)
  })

  it('enforces an event transfer restriction on-chain', async () => {
    const issued = await issueTicket(false)
    const recipient = Keypair.generate()
    await fund(issued.owner)
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    await expectRejected(program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ currentOwner: issued.owner.publicKey, event: issued.event, ticket: issued.ticket, recipient: recipient.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([issued.owner]).rpc(), ['transfersdisabled'])
  })

  it('allows the event organiser to check in a valid ticket', async () => {
    const issued = await issueTicket(true)
    await program.methods.checkInTicket(issued.ticketId)
      .accountsStrict({ organizer, event: issued.event, ticket: issued.ticket }).rpc()
    assert.isTrue((await program.account.ticketRecord.fetch(issued.ticket)).checkedIn)
  })

  it('rejects check-in signed by a wallet other than the event organiser', async () => {
    const issued = await issueTicket(true)
    const attacker = Keypair.generate()
    await fund(attacker)
    await expectRejected(program.methods.checkInTicket(issued.ticketId)
      .accountsStrict({ organizer: attacker.publicKey, event: issued.event, ticket: issued.ticket }).signers([attacker]).rpc(),
    ['constrainthasone', 'organizer'])
  })

  it('rejects a ticket account that does not match the supplied ticket ID', async () => {
    const issued = await issueTicket(true)
    const otherTicketId = newUuidBytes()
    await expectRejected(program.methods.checkInTicket(otherTicketId)
      .accountsStrict({ organizer, event: issued.event, ticket: issued.ticket }).rpc(), ['constraintseeds', 'seeds'])
  })

  it('rejects check-in for an unregistered ticket PDA', async () => {
    const { event } = await createEvent(true)
    const ticketId = newUuidBytes()
    await expectRejected(program.methods.checkInTicket(ticketId)
      .accountsStrict({ organizer, event, ticket: ticketAddress(event, ticketId) }).rpc(), ['accountnotinitialized', 'accountdidnotdeserialize'])
  })

  it('rejects a duplicate check-in', async () => {
    const issued = await issueTicket(true)
    const accounts = { organizer, event: issued.event, ticket: issued.ticket }
    await program.methods.checkInTicket(issued.ticketId).accountsStrict(accounts).rpc()
    await expectRejected(program.methods.checkInTicket(issued.ticketId).accountsStrict(accounts).rpc(), ['alreadycheckedin'])
  })

  it('allows the event organiser to invalidate a ticket', async () => {
    const issued = await issueTicket(true)
    await program.methods.invalidateTicket(issued.ticketId)
      .accountsStrict({ organizer, event: issued.event, ticket: issued.ticket }).rpc()
    assert.isFalse((await program.account.ticketRecord.fetch(issued.ticket)).valid)
  })

  it('rejects check-in and transfer after ticket invalidation', async () => {
    const issued = await issueTicket(true)
    await program.methods.invalidateTicket(issued.ticketId)
      .accountsStrict({ organizer, event: issued.event, ticket: issued.ticket }).rpc()
    await expectRejected(program.methods.checkInTicket(issued.ticketId)
      .accountsStrict({ organizer, event: issued.event, ticket: issued.ticket }).rpc(), ['invalidticket'])
    await fund(issued.owner)
    const recipient = Keypair.generate()
    const receipt = PublicKey.findProgramAddressSync([Buffer.from('transfer'), issued.ticket.toBuffer(), Buffer.alloc(4)], program.programId)[0]
    await expectRejected(program.methods.transferTicket(issued.ticketId)
      .accountsStrict({ currentOwner: issued.owner.publicKey, event: issued.event, ticket: issued.ticket, recipient: recipient.publicKey, receipt, systemProgram: SystemProgram.programId })
      .signers([issued.owner]).rpc(), ['invalidticket'])
  })
})
