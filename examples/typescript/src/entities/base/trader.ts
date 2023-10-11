import {
  createPublicClient,
  http,
  createWalletClient,
  publicActions,
  PublicClient,
  WalletClient,
  Address,
  PrivateKeyAccount,
  Transport,
  WriteContractParameters,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, arbitrumGoerli } from 'viem/chains';
import { ERC20Contract } from '../contracts/erc20.js';
import {
  CLEAR_ADDRESS,
  SEAPORT_ADDRESS,
  SupportedChain,
} from '../../../src/lib/constants.js';
import { authClient, handleGRPCRequest } from '../../../src/lib/grpc.js';
import { createSIWEMessage } from '../../../src/utils/index.js';
import { ClearinghouseContract } from '../contracts/clearinghouse.js';

export interface TraderConstructorArgs {
  privateKey: `0x${string}`;
  chain: typeof arbitrumGoerli | typeof arbitrum;
}

export class Trader {
  public account: PrivateKeyAccount;
  public chain: SupportedChain;
  public authenticated = false;
  public publicClient: PublicClient<Transport, SupportedChain>;
  public walletClient: WalletClient<
    Transport,
    SupportedChain,
    PrivateKeyAccount
  >;

  /** cached results */
  // { [ERC20_ADDRESS]: BALANCE}
  private erc20Balances = new Map<Address, bigint>();
  // { [ERC20_ADDRESS]: { [CLEAR_ADDRESS]: APPROVED_AMOUNT, [SEAPORT_ADDRESS]: APPROVED_AMOUNT } }
  private erc20Allowances = new Map<
    Address,
    {
      [CLEAR_ADDRESS]?: bigint;
      [SEAPORT_ADDRESS]?: bigint;
    }
  >();

  public constructor({ privateKey, chain }: TraderConstructorArgs) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    this.account = privateKeyToAccount(privateKey);
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(),
    }).extend(publicActions);

    this.chain = chain;
  }

  /**
   * Authenticate with Valorem Trade API via SIWE
   */
  public async signIn() {
    // check if already authenticated, early return if true
    if (this.authenticated) return;

    /**
     * 1. Get session nonce
     * 2. Create and sign SIWE message
     * 3. Submit verification to Valorem Trade API
     */
    const nonce = await this.getNonce();
    const { message, signature } = await this.createAndSignMessage(nonce);
    const { verified } = await this.verifyWithSIWE(message, signature);

    if (verified) {
      this.authenticated = true;
      console.log('Client has authenticated with Valorem Trade API!');
    } else {
      this.authenticated = false;
      console.log('SIWE Verification failed.');
    }
  }

  public async getNonce() {
    const res = await handleGRPCRequest(async () => await authClient.nonce({}));
    if (res === null) throw new Error('Failed to get nonce for SIWE message.');
    return res.nonce;
  }

  public async checkAuthentication() {
    const res = await handleGRPCRequest(
      async () => await authClient.authenticate({})
    );
    this.authenticated = res !== null;
  }

  public async verifyWithSIWE(message: string, signature: `0x${string}`) {
    const res = await handleGRPCRequest(async () => {
      await authClient.verify({
        body: JSON.stringify({
          message,
          signature,
        }),
      });
    });
    return { verified: res !== null };
  }

  public async createAndSignMessage(nonce: string) {
    const message = createSIWEMessage({
      nonce,
      chainId: this.chain.id,
      address: this.account.address,
    });
    const signature = await this.account.signMessage({ message });
    return { message, signature };
  }

  /**
   * Contract Reads
   */
  public hasEnoughERC20Balance = async ({
    erc20,
    amount,
  }: {
    erc20: ERC20Contract;
    amount: bigint;
  }) => {
    const balance = await this.getBalanceOf(erc20);
    return balance >= amount;
  };

  public hasEnoughERC20Allowance = async ({
    erc20,
    spender,
    amount,
  }: {
    erc20: ERC20Contract;
    spender: typeof CLEAR_ADDRESS | typeof SEAPORT_ADDRESS;
    amount: bigint;
  }) => {
    const approvedAmount = await this.getAllowanceFor({ erc20, spender });
    return approvedAmount >= amount;
  };

  private getBalanceOf = async (erc20: ERC20Contract) => {
    const cachedBalance = this.erc20Balances.get(erc20.address);
    if (cachedBalance) {
      return cachedBalance;
    }
    const balance = await erc20.read.balanceOf([this.account.address]);
    this.erc20Balances.set(erc20.address, balance);
    return balance;
  };

  private getAllowanceFor = async ({
    erc20,
    spender,
  }: {
    erc20: ERC20Contract;
    spender: typeof CLEAR_ADDRESS | typeof SEAPORT_ADDRESS;
  }) => {
    const cachedAllowance = this.erc20Allowances.get(erc20.address)?.[spender];
    if (cachedAllowance) {
      return cachedAllowance;
    }
    const allowance = await erc20.read.allowance([
      this.account.address,
      spender,
    ]);
    this.erc20Allowances.set(erc20.address, {
      ...this.erc20Allowances.get(erc20.address),
      [spender]: allowance,
    });
    return allowance;
  };

  /**
   * Contract Writes
   */
  public async approveERC20({
    erc20,
    spender,
    amount,
  }: {
    erc20: ERC20Contract;
    spender: Address;
    amount: bigint;
  }) {
    // prepare tx
    const { request } = await erc20.simulate.approve([spender, amount]);
    // send tx
    const receipt = await this.executeTransaction(request);
    // check result
    if (receipt.status === 'success') {
      console.log(
        `Successfully approved ${spender} for ${parseUnits(
          amount.toString(),
          erc20.decimals
        )} ${erc20.symbol}`
      );
    }
  }

  public async exerciseOption({
    optionId,
    amount,
    clearinghouse,
  }: {
    optionId: bigint;
    amount: bigint;
    clearinghouse: ClearinghouseContract;
  }) {
    // prepare tx
    const { request } = await clearinghouse.simulate.exercise([
      optionId,
      amount,
    ]);
    // send tx
    const receipt = await this.executeTransaction(request);
    // check result
    if (receipt.status === 'success') {
      console.log(
        `Successfully exercised ${amount}x options, with ID ${optionId.toString()}`
      );
    }
  }

  public async redeemClaim({
    optionId,
    clearinghouse,
  }: {
    optionId: bigint;
    clearinghouse: ClearinghouseContract;
  }) {
    // prepare tx
    const { request } = await clearinghouse.simulate.redeem([optionId]);
    // send tx
    const receipt = await this.executeTransaction(request);
    // check result
    if (receipt.status === 'success') {
      console.log(`Successfully redeemed claim with ID ${optionId.toString()}`);
    }
  }

  public async executeTransaction(request: WriteContractParameters) {
    // submit tx to chain
    const hash = await this.walletClient.writeContract(request);
    // wait for tx to be mined
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
    });
    // throw error with txHash if tx failed
    if (receipt.status === 'reverted') {
      throw new Error(`Transaction failed. Hash: ${receipt.transactionHash}`);
    }
    return receipt;
  }
}
