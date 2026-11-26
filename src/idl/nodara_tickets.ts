/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/nodara_tickets.json`.
 */
export type NodaraTickets = {
  "address": "CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf",
  "metadata": {
    "name": "nodaraTickets",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Devnet program-controlled NODARA ticket ownership"
  },
  "instructions": [
    {
      "name": "checkInTicket",
      "discriminator": [
        174,
        66,
        18,
        131,
        231,
        120,
        103,
        246
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event.event_id",
                "account": "eventRecord"
              }
            ]
          },
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "arg",
                "path": "ticketId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "ticketId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "createEvent",
      "discriminator": [
        49,
        219,
        29,
        203,
        22,
        98,
        100,
        87
      ],
      "accounts": [
        {
          "name": "organizer",
          "writable": true,
          "signer": true
        },
        {
          "name": "event",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "eventId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "eventId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "transfersAllowed",
          "type": "bool"
        }
      ]
    },
    {
      "name": "invalidateTicket",
      "discriminator": [
        216,
        70,
        125,
        212,
        134,
        129,
        244,
        180
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event.event_id",
                "account": "eventRecord"
              }
            ]
          },
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "arg",
                "path": "ticketId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "ticketId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "registerTicket",
      "discriminator": [
        109,
        13,
        236,
        88,
        213,
        108,
        159,
        122
      ],
      "accounts": [
        {
          "name": "organizer",
          "writable": true,
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event.event_id",
                "account": "eventRecord"
              }
            ]
          }
        },
        {
          "name": "initialOwner"
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "arg",
                "path": "ticketId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticketId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "setTransferPolicy",
      "discriminator": [
        198,
        216,
        170,
        163,
        66,
        251,
        2,
        51
      ],
      "accounts": [
        {
          "name": "organizer",
          "signer": true,
          "relations": [
            "event"
          ]
        },
        {
          "name": "event",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event.event_id",
                "account": "eventRecord"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "allowed",
          "type": "bool"
        }
      ]
    },
    {
      "name": "transferTicket",
      "discriminator": [
        191,
        184,
        74,
        239,
        164,
        172,
        188,
        32
      ],
      "accounts": [
        {
          "name": "currentOwner",
          "writable": true,
          "signer": true
        },
        {
          "name": "event",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event.event_id",
                "account": "eventRecord"
              }
            ]
          },
          "relations": [
            "ticket"
          ]
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "event"
              },
              {
                "kind": "arg",
                "path": "ticketId"
              }
            ]
          }
        },
        {
          "name": "recipient"
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  110,
                  115,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.transfer_count",
                "account": "ticketRecord"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticketId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "eventRecord",
      "discriminator": [
        150,
        209,
        156,
        235,
        9,
        198,
        56,
        184
      ]
    },
    {
      "name": "ticketRecord",
      "discriminator": [
        37,
        215,
        102,
        48,
        114,
        66,
        21,
        87
      ]
    },
    {
      "name": "transferReceipt",
      "discriminator": [
        166,
        220,
        49,
        50,
        221,
        185,
        59,
        55
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidTicket",
      "msg": "Ticket is invalid or cancelled"
    },
    {
      "code": 6001,
      "name": "alreadyCheckedIn",
      "msg": "Ticket has already been checked in"
    },
    {
      "code": 6002,
      "name": "transfersDisabled",
      "msg": "The event does not allow transfers"
    },
    {
      "code": 6003,
      "name": "notOwner",
      "msg": "Only the current owner may transfer this ticket"
    },
    {
      "code": 6004,
      "name": "counterOverflow",
      "msg": "Transfer history counter overflowed"
    },
    {
      "code": 6005,
      "name": "invalidRecipient",
      "msg": "Recipient address cannot be the default public key"
    },
    {
      "code": 6006,
      "name": "sameOwner",
      "msg": "Ticket is already owned by this recipient"
    }
  ],
  "types": [
    {
      "name": "eventRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "eventId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "organizer",
            "type": "pubkey"
          },
          {
            "name": "transfersAllowed",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "ticketRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "event",
            "type": "pubkey"
          },
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "valid",
            "type": "bool"
          },
          {
            "name": "checkedIn",
            "type": "bool"
          },
          {
            "name": "transferCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "transferReceipt",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "from",
            "type": "pubkey"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "sequence",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
