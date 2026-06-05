import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SummonerProfile, RiotApiService } from '../../services/riot-api';

@Component({
  selector: 'app-profile-card',
  imports: [CommonModule],
  templateUrl: './profile-card.html',
  styleUrl: './profile-card.css'
})
export class ProfileCard {
  @Input() profile!: SummonerProfile;
  constructor(public riotApi: RiotApiService) {}
}
